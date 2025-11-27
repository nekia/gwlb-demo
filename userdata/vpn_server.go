package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
)

func xor(data []byte, key []byte) []byte {
	out := make([]byte, len(data))
	for i := range data {
		out[i] = data[i] ^ key[i%len(key)]
	}
	return out
}

func healthCheckHandler(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, "OK")
}

func main() {
	listen := flag.String("listen", ":6081", "UDP listen (GENEVE)")
	healthPort := flag.String("health-port", ":80", "TCP listen for Health Check")
	client := flag.String("client", "10.60.1.50:6000", "client udp addr")
	keyStr := flag.String("key", "secret", "xor key")
	flag.Parse()

	key := []byte(*keyStr)

	// Start Health Check Server (TCP 80)
	go func() {
		http.HandleFunc("/", healthCheckHandler)
		log.Println("[HEALTH CHECK] started on", *healthPort)
		log.Fatal(http.ListenAndServe(*healthPort, nil))
	}()

	svrAddr, err := net.ResolveUDPAddr("udp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	conn, err := net.ListenUDP("udp", svrAddr)
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()

	clientAddr, err := net.ResolveUDPAddr("udp", *client)
	if err != nil {
		log.Fatal(err)
	}

	buf := make([]byte, 65535)
	log.Println("[VPN SERVER] started on", *listen)

	for {
		n, src, err := conn.ReadFromUDP(buf)
		if err != nil {
			log.Println("Read error:", err)
			continue
		}

		// Parse GENEVE Header
		// RFC 8926: Fixed (8 bytes) + Options (Variable)
		if n < 8 {
			continue
		}
		
		// Byte 0: Ver(2)|OptLen(6)
		optLen := int(buf[0] & 0x3F)
		geneveHeaderLen := 8 + (optLen * 4)
		
		if n < geneveHeaderLen {
			continue
		}

		// Inner Packet (IPv4)
		innerPacket := buf[geneveHeaderLen:n]
		
		// Minimal IPv4 check
		if len(innerPacket) < 20 {
			continue
		}
		
		// IHL (Internet Header Length)
		ihl := int(innerPacket[0] & 0x0F)
		ipHeaderLen := ihl * 4
		
		if len(innerPacket) < ipHeaderLen {
			continue
		}

		// Protocol (Byte 9). UDP = 17
		if innerPacket[9] != 17 && innerPacket[9] != 6 {
			continue
		}

		var payload []byte

		if innerPacket[9] == 17 {
			// UDP Header (8 bytes)
			udpPacket := innerPacket[ipHeaderLen:]
			if len(udpPacket) < 8 {
				continue
			}
			// Payload
			payload = udpPacket[8:]
		} else {
			// TCP Header
			tcpPacket := innerPacket[ipHeaderLen:]
			if len(tcpPacket) < 20 {
				continue
			}
			dataOffset := (tcpPacket[12] >> 4) * 4
			if len(tcpPacket) < int(dataOffset) {
				continue
			}
			payload = tcpPacket[dataOffset:]
		}
		
		// Log
		data := xor(payload, key)
		log.Printf("FROM BACKEND via GWLB (%s) Proto %d: %s", src.String(), innerPacket[9], string(data))

		// Forward to Client (One-way for demo)
		enc := xor(data, key)
		_, err = conn.WriteToUDP(enc, clientAddr)
		if err != nil {
			log.Println("WriteToUDP error:", err)
		}
	}
}
