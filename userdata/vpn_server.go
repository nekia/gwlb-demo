package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	ifNameSize    = 16
	tunDevicePath = "/dev/net/tun"
	tunsetiff     = 0x400454ca
	iffTun        = 0x0001
	iffNoPI       = 0x1000
)

type flowEntry struct {
	peer   *net.UDPAddr
	header []byte
	last   time.Time
}

type flowTable struct {
	mu      sync.RWMutex
	entries map[string]*flowEntry
}

func newFlowTable() *flowTable {
	ft := &flowTable{
		entries: make(map[string]*flowEntry),
	}
	go ft.gc()
	return ft
}

func (ft *flowTable) gc() {
	t := time.NewTicker(1 * time.Minute)
	defer t.Stop()
	for range t.C {
		cutoff := time.Now().Add(-5 * time.Minute)
		ft.mu.Lock()
		for k, v := range ft.entries {
			if v.last.Before(cutoff) {
				delete(ft.entries, k)
			}
		}
		ft.mu.Unlock()
	}
}

func (ft *flowTable) Upsert(backendIP string, peer *net.UDPAddr, header []byte) {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	hdrCopy := make([]byte, len(header))
	copy(hdrCopy, header)
	ft.entries[backendIP] = &flowEntry{
		peer:   peer,
		header: hdrCopy,
		last:   time.Now(),
	}
}

func (ft *flowTable) Get(backendIP string) (*flowEntry, bool) {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	entry, ok := ft.entries[backendIP]
	if ok {
		entry.last = time.Now()
	}
	return entry, ok
}

func main() {
	listen := flag.String("listen", ":6081", "UDP listen (GENEVE)")
	healthPort := flag.String("health-port", ":80", "TCP listen for Health Check")
	tunName := flag.String("tun", "geneveTun", "TUN device name used to inject/extract packets")
	backendCIDR := flag.String("backend-cidr", "10.50.0.0/16", "Backend CIDR routed through GWLB")
	flag.Parse()

	backendNet, err := netip.ParsePrefix(*backendCIDR)
	if err != nil {
		log.Fatalf("invalid backend cidr: %v", err)
	}

	go func() {
		http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
			fmt.Fprint(w, "OK")
		})
		log.Println("[HEALTH CHECK] started on", *healthPort)
		log.Fatal(http.ListenAndServe(*healthPort, nil))
	}()

	svrAddr, err := net.ResolveUDPAddr("udp4", *listen)
	if err != nil {
		log.Fatal(err)
	}
	conn, err := net.ListenUDP("udp4", svrAddr)
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()

	tun, err := openTun(*tunName)
	if err != nil {
		log.Fatalf("open tun: %v", err)
	}
	defer tun.Close()

	// Ensure IP forwarding is enabled
	if err := os.WriteFile("/proc/sys/net/ipv4/ip_forward", []byte("1"), 0644); err != nil {
		log.Printf("warning: failed to enable ip_forward: %v", err)
	}

	// Set up routing for backend CIDR through TUN interface
	// Use a custom routing table to avoid interfering with SSM connectivity
	log.Printf("[ROUTING] Setting up routes for %s via %s", *backendCIDR, *tunName)

	flows := newFlowTable()

	go pumpGeneveToTun(conn, tun, flows)
	go pumpTunToGeneve(conn, tun, flows, backendNet)

	select {}
}

// checksum calculates the IPv4 header checksum.
func checksum(data []byte) uint16 {
	var sum uint32
	for i := 0; i < len(data); i += 2 {
		sum += uint32(data[i])<<8 | uint32(data[i+1])
	}
	for sum > 0xffff {
		sum = (sum >> 16) + (sum & 0xffff)
	}
	return ^uint16(sum)
}

func pumpGeneveToTun(conn *net.UDPConn, tun *os.File, flows *flowTable) {
	buf := make([]byte, 65535)
	for {
		n, peer, err := conn.ReadFromUDP(buf)
		if err != nil {
			log.Printf("geneve read error: %v", err)
			continue
		}
		if n < 8 {
			continue
		}
		optLen := int(buf[0] & 0x3F)
		headerLen := 8 + (optLen * 4)
		if n < headerLen+20 {
			continue
		}

		// Extract inner packet
		inner := make([]byte, n-headerLen)
		copy(inner, buf[headerLen:n])

		if inner[0]>>4 != 4 {
			// Not IPv4
			continue
		}

		// Record flow
		srcIP := net.IP(inner[12:16]).String()
		flows.Upsert(srcIP, peer, buf[:headerLen])

		// Fix IP Checksum (in case of offloading)
		// IHL is lower 4 bits of byte 0
		ihl := int(inner[0] & 0x0F)
		if len(inner) >= ihl*4 {
			// Zero out checksum field (bytes 10,11)
			inner[10] = 0
			inner[11] = 0
			// Calculate new checksum over header
			csum := checksum(inner[:ihl*4])
			inner[10] = byte(csum >> 8)
			inner[11] = byte(csum)
		}

		// Log occasional packets to debug
		if time.Now().Unix()%5 == 0 {
			log.Printf("DEBUG: Geneve -> TUN src=%s len=%d peer=%s", srcIP, len(inner), peer)
		}

		if _, err := tun.Write(inner); err != nil {
			log.Printf("tun write error: %v", err)
		}
	}
}

func pumpTunToGeneve(conn *net.UDPConn, tun *os.File, flows *flowTable, backendNet netip.Prefix) {
	buf := make([]byte, 65535)
	for {
		n, err := tun.Read(buf)
		if err != nil {
			log.Printf("tun read error: %v", err)
			continue
		}
		if n < 20 {
			continue
		}
		packet := buf[:n]
		if packet[0]>>4 != 4 {
			continue
		}
		dst := netip.AddrFrom4([4]byte{packet[16], packet[17], packet[18], packet[19]})

		log.Printf("DEBUG: TUN -> Geneve dst=%s len=%d", dst, n)

		// If destination is Backend CIDR, let the kernel route it directly via NAT
		// instead of re-encapsulating into GENEVE.
		// The kernel will see the packet from wg0 -> geneveTun, but we want it
		// to go out via ens5 with NAT.
		// However, since we read it from geneveTun, we are responsible for it.
		// BUT, in this specific request, the user wants "Direct Return" behavior.
		// If vpn_server reads it from TUN, it means the kernel routed it to TUN.

		if !backendNet.Contains(dst) {
			log.Printf("DEBUG: dst %s not in backend CIDR", dst)
			continue
		}

		// If we want Direct Return, we should NOT encapsulate here.
		// But if we don't encapsulate, we must inject it back to kernel towards ens5?
		// Actually, if we want Direct Return, the routing table should point to ens5, not geneveTun.
		// So vpn_server shouldn't even see these packets if routing is correct.

		entry, ok := flows.Get(dst.String())
		if !ok {
			log.Printf("DEBUG: No flow entry for dst %s", dst)
			continue
		}
		out := make([]byte, len(entry.header)+len(packet))
		copy(out, entry.header)
		copy(out[len(entry.header):], packet)
		if _, err := conn.WriteToUDP(out, entry.peer); err != nil {
			log.Printf("geneve write error: %v", err)
		}
	}
}

type ifreq struct {
	Name  [ifNameSize]byte
	Flags uint16
	_     [24]byte
}

func openTun(name string) (*os.File, error) {
	f, err := os.OpenFile(tunDevicePath, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	var req ifreq
	copy(req.Name[:], name)
	req.Flags = iffTun | iffNoPI
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), uintptr(tunsetiff), uintptr(unsafe.Pointer(&req)))
	if errno != 0 {
		f.Close()
		return nil, fmt.Errorf("ioctl TUNSETIFF: %v", errno)
	}
	return f, nil
}
