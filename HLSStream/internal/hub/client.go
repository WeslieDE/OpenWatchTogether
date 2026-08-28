// Package hub verbindet sich mit dem bestehenden Live-Prozess (ws/server.php)
// genau wie ein Browser: gleiche Handshake-Adresse (?room=&name=), gleiches
// {type,data}-Nachrichtenformat - siehe die Docblock-Uebersicht in
// src/Ws/Hub.php und das Pendant assets/js/net.js. Es gibt keine
// Sonderbehandlung auf PHP-Seite fuer diesen Client.
package hub

import (
	"encoding/json"
	"log"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	pingInterval = 2 * time.Second
	retryMin     = 1 * time.Second
	retryMax     = 15 * time.Second
)

type VideoState struct {
	Playing bool    `json:"playing"`
	T       float64 `json:"t"`
}

type QueueItem struct {
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	URL      string  `json:"url"`
	Duration float64 `json:"duration"`
}

type Settings struct {
	Go bool `json:"go"`
}

type LiveState struct {
	On   bool    `json:"on"`
	ByID *string `json:"byId"`
}

type Welcome struct {
	Master   *string     `json:"master"`
	Video    VideoState  `json:"video"`
	Now      *string     `json:"now"`
	Queue    []QueueItem `json:"queue"`
	Resume   float64     `json:"resume"`
	Settings Settings    `json:"settings"`
	Live     LiveState   `json:"live"`
}

// Event ist eine flache Vereinigung aller Nachrichten, die fuer HLSStream von
// Belang sind. Kind sagt, welches Feld gueltig ist.
type Event struct {
	Kind string // "connected" | "disconnected" | "welcome" | "video" | "now" | "queue" | "settings" | "live" | "denied"

	Welcome  Welcome
	Video    VideoState
	NowID    *string
	Queue    []QueueItem
	Settings Settings
	Live     LiveState
	Denied   string
}

type wireMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// Client haelt die Verbindung zu einem einzelnen Raum am Leben, mit
// wachsendem Backoff bei Abriss - dasselbe Verhalten wie net.js im Browser.
type Client struct {
	url    string
	events chan Event

	mu     sync.Mutex
	conn   *websocket.Conn
	closed bool
}

// Connect baut die Verbindung im Hintergrund auf und liefert Events, bis
// Close() aufgerufen wird.
func Connect(host string, port int, room string) *Client {
	q := url.Values{}
	q.Set("room", room)
	q.Set("name", "HLSStream")
	addr := "ws://" + host + ":" + strconv.Itoa(port) + "/?" + q.Encode()

	c := &Client{
		url:    addr,
		events: make(chan Event, 32),
	}
	go c.run()
	return c
}

func (c *Client) Events() <-chan Event { return c.events }

func (c *Client) run() {
	backoff := retryMin
	for {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return
		}
		c.mu.Unlock()

		conn, _, err := websocket.DefaultDialer.Dial(c.url, nil)
		if err != nil {
			log.Printf("[hub] Verbindung fehlgeschlagen (%v), neuer Versuch in %s", err, backoff)
			if !c.sleep(backoff) {
				return
			}
			backoff = nextBackoff(backoff)
			continue
		}

		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			_ = conn.Close()
			return
		}
		c.conn = conn
		c.mu.Unlock()

		backoff = retryMin
		c.emit(Event{Kind: "connected"})
		c.readLoop(conn)
		c.emit(Event{Kind: "disconnected"})

		if !c.sleep(retryMin) {
			return
		}
	}
}

func (c *Client) sleep(d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	<-t.C
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.closed
}

func nextBackoff(d time.Duration) time.Duration {
	d = d * 2
	if d > retryMax {
		return retryMax
	}
	return d
}

func (c *Client) readLoop(conn *websocket.Conn) {
	stopPing := make(chan struct{})
	go c.pingLoop(conn, stopPing)
	defer close(stopPing)

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var msg wireMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		c.dispatch(msg)
	}
}

func (c *Client) pingLoop(conn *websocket.Conn, stop <-chan struct{}) {
	t := time.NewTicker(pingInterval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			c.Send("ping", struct{}{})
		}
	}
}

func (c *Client) dispatch(msg wireMessage) {
	switch msg.Type {
	case "welcome":
		var w Welcome
		if err := json.Unmarshal(msg.Data, &w); err != nil {
			return
		}
		c.emit(Event{Kind: "welcome", Welcome: w})

	case "video":
		var v VideoState
		if err := json.Unmarshal(msg.Data, &v); err != nil {
			return
		}
		c.emit(Event{Kind: "video", Video: v})

	case "now":
		var d struct {
			ID *string `json:"id"`
		}
		if err := json.Unmarshal(msg.Data, &d); err != nil {
			return
		}
		c.emit(Event{Kind: "now", NowID: d.ID})

	case "queue":
		var d struct {
			Items []QueueItem `json:"items"`
		}
		if err := json.Unmarshal(msg.Data, &d); err != nil {
			return
		}
		c.emit(Event{Kind: "queue", Queue: d.Items})

	case "settings":
		var s Settings
		if err := json.Unmarshal(msg.Data, &s); err != nil {
			return
		}
		c.emit(Event{Kind: "settings", Settings: s})

	case "live":
		var l LiveState
		if err := json.Unmarshal(msg.Data, &l); err != nil {
			return
		}
		c.emit(Event{Kind: "live", Live: l})

	case "denied":
		var d struct {
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(msg.Data, &d); err != nil {
			return
		}
		c.emit(Event{Kind: "denied", Denied: d.Reason})
	}
}

func (c *Client) emit(e Event) {
	select {
	case c.events <- e:
	default:
		// Der Konsument haengt gerade - lieber eine alte Statusmeldung
		// verlieren als hier zu blockieren und die Leseschleife zu stauen.
		log.Printf("[hub] Event-Puffer voll, %q wird verworfen", e.Kind)
	}
}

// Send schickt eine Nachricht im selben {type,data}-Umschlag wie das
// bestehende Protokoll. Ohne offene Verbindung wird sie stillschweigend
// verworfen - der naechste "welcome" nach dem Wiederaufbau bringt ohnehin
// den vollen Zustand mit.
func (c *Client) Send(msgType string, data any) {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return
	}
	line, err := json.Marshal(struct {
		Type string `json:"type"`
		Data any    `json:"data"`
	}{msgType, data})
	if err != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return
	}
	_ = c.conn.WriteMessage(websocket.TextMessage, line)
}

func (c *Client) Close() {
	c.mu.Lock()
	c.closed = true
	conn := c.conn
	c.conn = nil
	c.mu.Unlock()
	if conn != nil {
		line, _ := json.Marshal(struct {
			Type string `json:"type"`
			Data any    `json:"data"`
		}{"bye", struct{}{}})
		_ = conn.WriteMessage(websocket.TextMessage, line)
		_ = conn.Close()
	}
}
