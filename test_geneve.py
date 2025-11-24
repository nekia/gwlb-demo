import socket
import struct
import sys

# GENEVE Header Construction
# Ver(2) | OptLen(6) | O | C | Rsvd(6) | Protocol(16) | VNI(24) | Rsvd(8)
# We use minimal header: OptLen=0, Proto=IPv4(0x0800), VNI=0
def build_geneve_header(proto=0x0800, vni=0):
    # Byte 0: Ver(0) | OptLen(0) = 0x00
    # Byte 1: Flags(0)
    # Byte 2-3: Protocol Type
    # Byte 4-6: VNI
    # Byte 7: Reserved
    
    # To simulate AWS GWLB, we might want to add some Options (TLV)
    # But our Go server just skips them based on OptLen, so 0 length is fine for basic test.
    # However, AWS GWLB *always* sends options (ENI ID, etc).
    # Let's add a dummy option to verify the OptLen parsing logic.
    
    # Option: Class(2B)|Type(1B)|R(3)|Len(5) | Data...
    # Let's make OptLen = 1 (4 bytes). 
    # Note: OptLen in header is in multiples of 4 bytes.
    
    opt_data = b'\xaa\xbb\xcc\xdd' # Dummy option data (4 bytes)
    opt_len_field = 1 # 1 * 4 bytes = 4 bytes total option length
    
    # Header Byte 0: Ver(00)..OptLen(000001) -> 0x01
    ver_optlen = (0 << 6) | (opt_len_field & 0x3F)
    
    header = struct.pack('!BBH3sB', ver_optlen, 0, proto, b'\x00\x00\x00', 0)
    return header + opt_data

# IPv4 Header Construction
def build_ipv4_header(src_ip, dst_ip, proto=17): # UDP=17
    # Minimal 20 bytes
    ver_ihl = (4 << 4) | 5
    tos = 0
    tot_len = 20 + 8 + 10 # IP(20) + UDP(8) + Payload(10) - approximate
    id_ = 54321
    frag_off = 0
    ttl = 64
    check = 0 # Kernel will calculate if using raw sockets, but we are sending UDP payload so we just put 0
    s_addr = socket.inet_aton(src_ip)
    d_addr = socket.inet_aton(dst_ip)
    
    header = struct.pack('!BBHHHBBH4s4s', ver_ihl, tos, tot_len, id_, frag_off, ttl, proto, check, s_addr, d_addr)
    return header

# UDP Header Construction
def build_udp_header(src_port, dst_port, payload):
    length = 8 + len(payload)
    check = 0 # Optional for IPv4
    header = struct.pack('!HHHH', src_port, dst_port, length, check)
    return header + payload

def send_geneve_packet(target_ip, target_port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    
    # 1. Inner Payload (Original traffic)
    inner_payload = b"Hello GWLB"
    
    # 2. Inner UDP
    inner_udp = build_udp_header(12345, 80, inner_payload)
    
    # 3. Inner IP (10.0.0.10 -> 8.8.8.8)
    inner_ip = build_ipv4_header("10.0.0.10", "8.8.8.8") + inner_udp
    
    # 4. GENEVE Header (Proto 0x0800 for IPv4)
    geneve_header = build_geneve_header(proto=0x0800)
    
    # 5. Outer UDP Payload
    final_packet = geneve_header + inner_ip
    
    print(f"Sending GENEVE packet to {target_ip}:{target_port}...")
    print(f"Inner Packet: {inner_payload}")
    
    sock.sendto(final_packet, (target_ip, target_port))
    sock.close()

if __name__ == "__main__":
    target = "127.0.0.1"
    port = 6081
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    
    send_geneve_packet(target, port)

