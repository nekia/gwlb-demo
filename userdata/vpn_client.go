package main

import (
    "flag"
    "fmt"
    "log"
    "net"
)

func xor(data []byte, key []byte) []byte {
    out := make([]byte, len(data))
    for i := range data {
        out[i] = data[i] ^ key[i%len(key)]
    }
    return out
}

func main() {
    listen := flag.String("listen", ":6000", "udp listen for tunnel")
    server := flag.String("server", "192.168.100.10:5000", "server udp address")
    keyStr := flag.String("key", "secret", "xor key")
    flag.Parse()

    key := []byte(*keyStr)

    laddr, _ := net.ResolveUDPAddr("udp", *listen)
    conn, _ := net.ListenUDP("udp", laddr)
    defer conn.Close()

    serverAddr, _ := net.ResolveUDPAddr("udp", *server)

    // クライアントからサーバへデモメッセージ
    first := xor([]byte("hello from client (vIP 10.0.0.10)"), key)
    conn.WriteToUDP(first, serverAddr)

    log.Println("[VPN CLIENT] waiting packets...")

    buf := make([]byte, 65535)
    for {
        n, src, _ := conn.ReadFromUDP(buf)
        data := xor(buf[:n], key)

        fmt.Printf("[TUNNEL] from %s: %s\n", src.String(), string(data))
    }
}
