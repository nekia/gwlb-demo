import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbv2_targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as fs from "fs";

export class GwlbDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //
    // Load Go VPN source from local userdata folder
    //
    const vpnServerSrc = fs.readFileSync("userdata/vpn_server.go", "utf8");
    const vpnClientSrc = fs.readFileSync("userdata/vpn_client.go", "utf8");

    //
    // WireGuard (Overlay ↔︎ VPN Client)
    //
    const wireguardPort = 51820;
    const wireguardNetworkCidr = "10.0.0.0/16";
    const wireguardServerIp = "10.0.0.1";
    const wireguardClientIp = "10.0.0.10";
    const wireguardServerPrivateKey = "IE11NmqzhJq4Y+EueTRrAJD6DSB4MdVo2Alfx46+m0M=";
    const wireguardServerPublicKey = "dCXIy7zfYtCi01k5ZpqAPZNouB3iOp2b0iRjY3equyk=";
    const wireguardClientPrivateKey = "4JIX9h3maEHTdqNwpjKDej8iRdP8dkgpQuw4XZld6FE=";
    const wireguardClientPublicKey = "VwlhB3m1zfYLaF5WEKD7K3eri8EjpCWGLZ30iUN6qRY=";
    const backendNetworkCidr = "10.50.0.0/16";
    const geneveTunnelInterface = "geneveTun";

    //
    // Backend VPC
    //
    const backendVpc = new ec2.Vpc(this, "BackendVpc", {
      ipAddresses: ec2.IpAddresses.cidr(backendNetworkCidr),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    //
    // Overlay VPC
    //
    const overlayVpc = new ec2.Vpc(this, "OverlayVpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.60.0.0/16"),
      maxAzs: 2,
    });

    //
    // VPC Peering (Backend VPC <-> Overlay VPC)
    //
    const peering = new ec2.CfnVPCPeeringConnection(this, "Peering", {
      vpcId: backendVpc.vpcId,
      peerVpcId: overlayVpc.vpcId,
    });

    // Route: Overlay VPC -> Backend VPC (via Peering)
    overlayVpc.publicSubnets.forEach((subnet, i) => {
      new ec2.CfnRoute(this, `OverlayToBackend${i}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: backendNetworkCidr,
        vpcPeeringConnectionId: peering.ref,
      });
    });

    // Route: Backend VPC -> Overlay VPC (via Peering)
    // Needed if we want to allow direct access from Backend to OverlayGW IP,
    // although the DSR flow uses Client IP (10.0.0.10).
    backendVpc.publicSubnets.forEach((subnet, i) => {
      new ec2.CfnRoute(this, `BackendToOverlay${i}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: "10.60.0.0/16",
        vpcPeeringConnectionId: peering.ref,
      });
    });

    //
    // GWLB
    //
    const gwlb = new elbv2.CfnLoadBalancer(this, "GWLB", {
      type: "gateway",
      subnets: overlayVpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds,
      loadBalancerAttributes: [{
        key: "load_balancing.cross_zone.enabled",
        value: "true"
      }]
    });

    //
    // GWLB Endpoint Service
    //
    const gwlbService = new ec2.CfnVPCEndpointService(this, "GwlbService", {
      gatewayLoadBalancerArns: [gwlb.ref],
      acceptanceRequired: false,
    });

    //
    // Target Group
    //
    const gwlbTg = new elbv2.CfnTargetGroup(this, "GwlbTg", {
      vpcId: overlayVpc.vpcId,
      protocol: "GENEVE",
      port: 6081,
      targetType: "instance",
      healthCheckProtocol: "TCP",
      healthCheckPort: "80", 
      healthCheckEnabled: true,
      healthCheckIntervalSeconds: 10,
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 2,
    });
    
    new elbv2.CfnListener(this, "GwlbListener", {
      loadBalancerArn: gwlb.ref,
      defaultActions: [
        {
          type: "forward",
          targetGroupArn: gwlbTg.ref,
        },
      ],
    });

    //
    // GWLBE（Backend側） - AZ（サブネット）ごとに作成
    //
    const gwlbes: ec2.CfnVPCEndpoint[] = [];
    backendVpc.publicSubnets.forEach((subnet, i) => {
      const gwlbe = new ec2.CfnVPCEndpoint(this, `BackendGwlbe${i}`, {
        vpcId: backendVpc.vpcId,
        serviceName: `com.amazonaws.vpce.${this.region}.${gwlbService.ref}`,
        vpcEndpointType: "GatewayLoadBalancer",
        subnetIds: [subnet.subnetId], // GWLBエンドポイントは1つのサブネットにつき1つ
      });
      gwlbes.push(gwlbe);
    });

    //
    // Overlay Gateway EC2（VPNサーバー）
    //
    const overlayInstanceRole = new iam.Role(this, "OverlayInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });
    const overlaySg = new ec2.SecurityGroup(this, "OverlaySg", {
      vpc: overlayVpc,
      allowAllOutbound: true,
    });
    overlaySg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(6081), "GWLB GENEVE通信を許可");
    overlaySg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "GWLBヘルスチェックを許可");

    // 疎通確認までの経緯と構成のポイント:
    // 1. iptables-services のインストール:
    //    Amazon Linux 2023 ではデフォルトで iptables が入っていないため、
    //    UserData の実行が途中で失敗し、vpn_server.go が生成されない問題が発生しました。
    //    明示的に iptables-services をインストールすることで解決しました。
    //
    // 2. IPv4 フォワーディングと TUN インターフェース:
    //    GENEVE カプセル化を解いたパケットをカーネル経由で WireGuard に渡すため、
    //    net.ipv4.ip_forward=1 と TUN インターフェース (geneveTun) の作成が必須です。
    //
    // 3. DSR (Direct Server Return) 構成:
    //    Backend -> GWLB -> OverlayGW -> Client という「行き」の経路に対し、
    //    「帰り」は Client -> OverlayGW -> Backend と直接戻す構成を採用しました。
    //    これには以下の設定が必要です：
    //    - OverlayGateway の Source/Dest Check を無効化 (自分以外のIPを送信するため)
    //    - Backend VPC と Overlay VPC の VPC Peering (直接通信経路の確保)
    //    - NAT (マスカレード) を無効化し、Client の IP アドレス (10.0.0.10) のまま Backend にパケットを届ける
    //
    // 4. vpn_server の IPv4 リッスン:
    //    Go の net.ListenUDP("udp", ...) は環境によって IPv6 ソケットで待ち受けることがあり、
    //    GWLB からの IPv4 GENEVE パケットを受け取れない問題がありました。
    //    "udp4" を明示することで確実に受信できるように修正しました。

    const serverUserData = ec2.UserData.forLinux();
    serverUserData.addCommands(
      "set -e",
      "dnf install -y amazon-ssm-agent golang tcpdump wireguard-tools",
      "systemctl enable --now amazon-ssm-agent",
      "dnf install -y iptables-services",
      "sysctl -w net.ipv4.ip_forward=1",
      "iptables -P FORWARD ACCEPT",
      
      // geneveTun インターフェースの作成
      `ip link show ${geneveTunnelInterface} || ip tuntap add dev ${geneveTunnelInterface} mode tun`,
      `ip link set ${geneveTunnelInterface} up`,
      `ip addr add 169.254.200.1/30 dev ${geneveTunnelInterface} || true`,

      // DSR (Direct Server Return) 構成:
      // Backend (10.50.0.0/16) への戻りパケットは、geneveTun (GWLB) 経由ではなく
      // デフォルトゲートウェイ (ens5) -> VPC Peering を通って直接返します。
      // このため、このインスタンスの Source/Dest Check は無効化する必要があります。
      
      `cat <<'EOF' >/etc/wireguard/wg0.conf
[Interface]
PrivateKey = ${wireguardServerPrivateKey}
Address = ${wireguardServerIp}/16
ListenPort = ${wireguardPort}
SaveConfig = false

[Peer]
PublicKey = ${wireguardClientPublicKey}
AllowedIPs = ${wireguardNetworkCidr}, ${backendNetworkCidr}
PersistentKeepalive = 25
EOF`,
      "chmod 600 /etc/wireguard/wg0.conf",
      "systemctl enable wg-quick@wg0",
      "wg-quick up wg0",
      
      "mkdir -p /opt/app",
      `cat <<'EOF' >/opt/app/vpn_server.go
${vpnServerSrc}
EOF`,
      "cd /opt/app",
      "export GOCACHE=/tmp/gocache",
      "export GOMODCACHE=/tmp/gomodcache",
      "go build -o /tmp/vpn_server vpn_server.go",
      "install -m 755 /tmp/vpn_server /usr/local/bin/vpn_server",
      // GENEVE (UDP 6081) をリッスン
      `nohup /usr/local/bin/vpn_server --listen :6081 --health-port :80 --tun ${geneveTunnelInterface} --backend-cidr ${backendNetworkCidr} >/var/log/vpn_server.log 2>&1 &`,
      "sleep 1"
    );

    const overlayEc2 = new ec2.Instance(this, "OverlayGatewayV2", {
      vpc: overlayVpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: overlaySg,
      instanceType: new ec2.InstanceType("t3.micro"),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      userData: serverUserData,
      role: overlayInstanceRole,
      sourceDestCheck: false, // DSRのため、VpnClientのソースIPでパケットを送信することを許可
    });

    // new elbv2.CfnTargetGroupAttachment(this, "AttachOverlay", {
    //   targetGroupArn: gwlbTg.ref,
    //   targetId: overlayEc2.instanceId,
    // });

    // Replace with this ↓ (追加)
    // gwlbTg.addTarget(new elbv2_targets.InstanceTarget(overlayEc2));

    gwlbTg.targets = [{
      id: overlayEc2.instanceId,
    }];

    //
    // VPN Client EC2（Overlay Gateway の背後）
    //
    const clientSg = new ec2.SecurityGroup(this, "ClientSg", {
      vpc: overlayVpc,
      allowAllOutbound: true,
    });
    clientSg.addIngressRule(overlaySg, ec2.Port.udp(wireguardPort), "WireGuard制御通信を許可");
    overlaySg.addIngressRule(clientSg, ec2.Port.udp(wireguardPort), "ClientからのWireGuard通信を許可");

    const clientUserData = ec2.UserData.forLinux();
    clientUserData.addCommands(
      "set -e",
      "dnf install -y amazon-ssm-agent golang tcpdump wireguard-tools",
      "systemctl enable --now amazon-ssm-agent",
      `cat <<'EOF' >/etc/wireguard/wg0.conf
[Interface]
PrivateKey = ${wireguardClientPrivateKey}
Address = ${wireguardClientIp}/16
SaveConfig = false

[Peer]
PublicKey = ${wireguardServerPublicKey}
# Backend CIDR も許可リストに含めることが重要 (戻りパケットを受け取るため)
AllowedIPs = ${wireguardNetworkCidr}, ${backendNetworkCidr}
Endpoint = ${overlayEc2.instancePrivateIp}:${wireguardPort}
PersistentKeepalive = 25
EOF`,
      "chmod 600 /etc/wireguard/wg0.conf",
      "systemctl enable wg-quick@wg0",
      "wg-quick up wg0",
      "mkdir -p /opt/app",
      `cat <<'EOF' >/opt/app/vpn_client.go
${vpnClientSrc}
EOF`,
      "cd /opt/app",
      "export GOCACHE=/tmp/gocache",
      "export GOMODCACHE=/tmp/gomodcache",
      "go build -o /tmp/vpn_client vpn_client.go",
      "install -m 755 /tmp/vpn_client /usr/local/bin/vpn_client",
      `nohup /usr/local/bin/vpn_client --listen ${wireguardClientIp}:8080 >/var/log/vpn_client.log 2>&1 &`,
      "sleep 1"
    );

    const vpnClientRole = new iam.Role(this, "VpnClientRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });

    const vpnClient = new ec2.Instance(this, "VpnClient", {
      vpc: overlayVpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: clientSg,
      instanceType: new ec2.InstanceType("t3.micro"),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      userData: clientUserData,
      privateIpAddress: "10.60.1.50",
      role: vpnClientRole,
    });

    //
    // Backend EC2（自動で test パケットを送る）
    //
    const backendUserData = ec2.UserData.forLinux();
    backendUserData.addCommands(
      "set -e",
      "dnf install -y amazon-ssm-agent nmap-ncat tcpdump curl",
      "systemctl enable --now amazon-ssm-agent",
      "echo 'auto test packet' | ncat -u 10.0.0.10 80",
      "curl -sS --max-time 2 http://10.0.0.10:8080 || true"
    );

    // const backendEc2 = new ec2.Instance(this, "BackendEc2", {
    //   vpc: backendVpc,
    //   vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    //   securityGroup: backendVpc.vpcDefaultSecurityGroup,
    //   instanceType: new ec2.InstanceType("t3.micro"),
    //   machineImage: ec2.MachineImage.latestAmazonLinux2023(),
    //   userData: backendUserData,
    // });

    const backendEc2Role = new iam.Role(this, "BackendEc2Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });

    const backendSg = new ec2.SecurityGroup(this, "BackendSg", {
      vpc: backendVpc,
      allowAllOutbound: true,
    });

    const backendEc2 = new ec2.Instance(this, "BackendEc2", {
      vpc: backendVpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true,
      securityGroup: backendSg,
      instanceType: new ec2.InstanceType("t3.micro"),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      userData: backendUserData,
      role: backendEc2Role,
    });

    //
    // Route: 10.0.0.0/16 → GWLBE
    //
    backendVpc.publicSubnets.forEach((subnet, i) => {
      new ec2.CfnRoute(this, `BackendToVip${i}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: wireguardNetworkCidr,
        vpcEndpointId: gwlbes[i].ref,
      });
    });

    //
    // Output
    //
    new cdk.CfnOutput(this, "OverlayGatewayPublicIp", {
      value: overlayEc2.instancePublicIp,
    });
  }
}
