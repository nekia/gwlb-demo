package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"time"
)

func main() {
	listen := flag.String("listen", "10.0.0.10:8080", "HTTP listen address on WireGuard interface")
	flag.Parse()

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "Hello from VPN client! time=%s remote=%s\n", time.Now().Format(time.RFC3339), r.RemoteAddr)
	})

	log.Printf("[VPN CLIENT] HTTP demo listening on %s", *listen)
	log.Fatal(http.ListenAndServe(*listen, nil))
}
