// Package sfuclient konsumiert eine laufende Bildschirmuebertragung aus dem
// SFU-Prozess (sfu/server.js) - als ganz normaler role=consume-Peer, wie ein
// Browser (siehe assets/js/webrtc.js), nur dass hier statt eines
// WebRTC-Empfangs eine "Plain RTP"-Transportvariante genutzt wird: der SFU
// schickt das Bild/Ton-RTP direkt an einen von uns gewaehlten localhost-Port,
// ohne ICE/DTLS. Diese Variante ist eine kleine, generische Erweiterung von
// sfu/server.js (siehe create-plain-transport/connect-plain-transport dort) -
// kein Sonderfall fuer HLSStream, nur eine RTP-Ausgabe fuer Consumer, die
// selbst kein WebRTC sprechen.
package sfuclient

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const requestTimeout = 8 * time.Second

// Producer, wie ihn der SFU meldet (new-producer / beim Beitritt bereits
// laufende).
type Producer struct {
	ID   string
	Kind string // "video" | "audio"
}

// Track ist das Ergebnis, konsumiert zu haben: genug, um eine SDP-Datei fuer
// ffmpeg zu bauen (siehe internal/pipeline).
type Track struct {
	Kind        string // "video" | "audio"
	Port        int    // localhost-Port, an den der SFU jetzt sendet
	PayloadType int
	MimeType    string // "video/VP8" | "audio/opus"
	ClockRate   int
	Channels    int // nur Audio
}

type wireMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// Session ist eine Verbindung zum SFU fuer genau einen Raum, solange dort
// eine Bildschirmuebertragung laeuft. Wird geschlossen, sobald der Raum die
// Uebertragung beendet - der SFU raeumt Transports/Consumer/Router dann von
// sich aus auf (siehe onClose()/maybeForgetRoom() in sfu/server.js).
type Session struct {
	conn *websocket.Conn

	mu       sync.Mutex
	replies  chan wireMessage
	Events   chan Producer // "new-producer"
	Closed   chan Producer // "producer-closed" (Kind bleibt leer - der SFU sagt es nicht mehr)
	rtpCaps  json.RawMessage
	nextPort int32

	closeOnce sync.Once
}

var portCounter int32 = 45000 // gemeinsamer, grob rotierender Pool fuer localhost-Ports

func nextPortPair() (video, audio int) {
	p := atomic.AddInt32(&portCounter, 4)
	if p > 45900 {
		atomic.StoreInt32(&portCounter, 45000)
		p = 45000
	}
	return int(p), int(p) + 2
}

// Open verbindet sich mit dem SFU als Zuschauer eines Raums und wartet auf
// die Router-Codec-Angaben. Existierende Producer (Uebertragung laeuft schon)
// kommen sofort als "new-producer" ueber Events.
func Open(host string, port int, room string) (*Session, error) {
	q := url.Values{}
	q.Set("room", room)
	q.Set("peer", "HLSStream")
	q.Set("role", "consume")
	addr := "ws://" + host + ":" + strconv.Itoa(port) + "/?" + q.Encode()

	conn, _, err := websocket.DefaultDialer.Dial(addr, nil)
	if err != nil {
		return nil, fmt.Errorf("sfu: verbindung fehlgeschlagen: %w", err)
	}

	s := &Session{
		conn:    conn,
		replies: make(chan wireMessage, 8),
		Events:  make(chan Producer, 8),
		Closed:  make(chan Producer, 8),
	}
	go s.readLoop()

	msg, err := s.waitReply("rtp-capabilities", requestTimeout)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	var d struct {
		RTPCapabilities json.RawMessage `json:"rtpCapabilities"`
	}
	if err := json.Unmarshal(msg.Data, &d); err != nil {
		_ = conn.Close()
		return nil, err
	}
	s.rtpCaps = d.RTPCapabilities
	return s, nil
}

func (s *Session) readLoop() {
	defer close(s.Events)
	defer close(s.Closed)
	for {
		_, raw, err := s.conn.ReadMessage()
		if err != nil {
			return
		}
		var msg wireMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		switch msg.Type {
		case "new-producer":
			var d struct {
				ProducerID string `json:"producerId"`
				Kind       string `json:"kind"`
			}
			if json.Unmarshal(msg.Data, &d) == nil {
				select {
				case s.Events <- Producer{ID: d.ProducerID, Kind: d.Kind}:
				default:
				}
			}
		case "producer-closed":
			select {
			case s.Closed <- Producer{}:
			default:
			}
		default:
			select {
			case s.replies <- msg:
			default:
				// Niemand wartet gerade auf eine Antwort - verwerfen statt die
				// Leseschleife zu blockieren (new-producer/producer-closed
				// muessen weiter durchkommen).
			}
		}
	}
}

func (s *Session) waitReply(wantType string, timeout time.Duration) (wireMessage, error) {
	deadline := time.After(timeout)
	for {
		select {
		case msg, ok := <-s.replies:
			if !ok {
				return wireMessage{}, fmt.Errorf("sfu: verbindung geschlossen")
			}
			if msg.Type == "error" {
				var d struct {
					Message string `json:"message"`
				}
				_ = json.Unmarshal(msg.Data, &d)
				return wireMessage{}, fmt.Errorf("sfu: %s", d.Message)
			}
			if msg.Type == wantType {
				return msg, nil
			}
			// nicht die erwartete Antwort - fuer den sequentiellen
			// Ablauf hier ungewoehnlich, wird ignoriert.
		case <-deadline:
			return wireMessage{}, fmt.Errorf("sfu: keine Antwort auf %q", wantType)
		}
	}
}

func (s *Session) send(msgType string, data any) error {
	line, err := json.Marshal(struct {
		Type string `json:"type"`
		Data any    `json:"data"`
	}{msgType, data})
	if err != nil {
		return err
	}
	return s.conn.WriteMessage(websocket.TextMessage, line)
}

// Consume nimmt einen gemeldeten Producer entgegen und richtet einen Plain-
// RTP-Transport dafuer ein: der SFU schickt das Bild bzw. den Ton ab jetzt an
// 127.0.0.1:<port>. Video und Audio bekommen je einen eigenen Port/Transport,
// damit ffmpeg sie ohne SSRC-Kunststuecke per SDP auseinanderhalten kann.
func (s *Session) Consume(p Producer, port int) (Track, error) {
	if err := s.send("create-plain-transport", struct{}{}); err != nil {
		return Track{}, err
	}
	created, err := s.waitReply("plain-transport-created", requestTimeout)
	if err != nil {
		return Track{}, err
	}
	var t struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(created.Data, &t); err != nil {
		return Track{}, err
	}

	if err := s.send("connect-plain-transport", struct {
		TransportID string `json:"transportId"`
		IP          string `json:"ip"`
		Port        int    `json:"port"`
	}{t.ID, "127.0.0.1", port}); err != nil {
		return Track{}, err
	}
	if _, err := s.waitReply("plain-transport-connected", requestTimeout); err != nil {
		return Track{}, err
	}

	if err := s.send("consume", struct {
		ProducerID      string          `json:"producerId"`
		RTPCapabilities json.RawMessage `json:"rtpCapabilities"`
	}{p.ID, s.rtpCaps}); err != nil {
		return Track{}, err
	}
	created2, err := s.waitReply("consumer-created", requestTimeout)
	if err != nil {
		return Track{}, err
	}
	var c struct {
		ID            string `json:"id"`
		Kind          string `json:"kind"`
		RTPParameters struct {
			Codecs []struct {
				MimeType    string `json:"mimeType"`
				PayloadType int    `json:"payloadType"`
				ClockRate   int    `json:"clockRate"`
				Channels    int    `json:"channels"`
			} `json:"codecs"`
		} `json:"rtpParameters"`
	}
	if err := json.Unmarshal(created2.Data, &c); err != nil {
		return Track{}, err
	}
	if len(c.RTPParameters.Codecs) == 0 {
		return Track{}, fmt.Errorf("sfu: consumer ohne codec-angabe")
	}
	codec := c.RTPParameters.Codecs[0]

	if err := s.send("resume-consumer", struct {
		ConsumerID string `json:"consumerId"`
	}{c.ID}); err != nil {
		return Track{}, err
	}

	return Track{
		Kind:        c.Kind,
		Port:        port,
		PayloadType: codec.PayloadType,
		MimeType:    codec.MimeType,
		ClockRate:   codec.ClockRate,
		Channels:    codec.Channels,
	}, nil
}

// NextPorts liefert ein Portpaar fuer je einen Video-/Audio-Plain-Transport.
func (s *Session) NextPorts() (video, audio int) { return nextPortPair() }

func (s *Session) Close() {
	s.closeOnce.Do(func() {
		_ = s.conn.Close()
	})
}
