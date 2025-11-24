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
    // Backend VPC
    //
    const backendVpc = new ec2.Vpc(this, "BackendVpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.50.0.0/16"),
      maxAzs: 2,
    });

    //
    // Overlay VPC
    //
    const overlayVpc = new ec2.Vpc(this, "OverlayVpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.60.0.0/16"),
      maxAzs: 2,
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
    // GWLBE（Backend側） - Create one per AZ (subnet)
    //
    const gwlbes: ec2.CfnVPCEndpoint[] = [];
    backendVpc.privateSubnets.forEach((subnet, i) => {
      const gwlbe = new ec2.CfnVPCEndpoint(this, `BackendGwlbe${i}`, {
        vpcId: backendVpc.vpcId,
        serviceName: `com.amazonaws.vpce.${this.region}.${gwlbService.ref}`,
        vpcEndpointType: "GatewayLoadBalancer",
        subnetIds: [subnet.subnetId], // Only one subnet allowed per GWLB Endpoint resource
      });
      gwlbes.push(gwlbe);
    });

    //
    // Overlay Gateway EC2（VPN Server）
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
    overlaySg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(5000));
    overlaySg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(6081), "Allow GWLB GENEVE");
    overlaySg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "Allow GWLB Health Check");

    const serverUserData = ec2.UserData.forLinux();
    serverUserData.addCommands(
      "dnf install -y amazon-ssm-agent",
      "systemctl enable --now amazon-ssm-agent",
      "yum install -y golang",
      "mkdir -p /opt/app",
      `cat <<'EOF' >/opt/app/vpn_server.go
${vpnServerSrc}
EOF`,
      "cd /opt/app",
      "go build -o vpn_server vpn_server.go",
      // Listen on 6081 (GENEVE)
      "nohup ./vpn_server --listen :6081 --client 10.60.1.50:6000 --key secret >/var/log/vpn_server.log 2>&1 &"
    );

    const overlayEc2 = new ec2.Instance(this, "OverlayGateway", {
      vpc: overlayVpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: overlaySg,
      instanceType: new ec2.InstanceType("t3.micro"),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      userData: serverUserData,
      role: overlayInstanceRole,
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
    clientSg.addIngressRule(overlaySg, ec2.Port.udp(6000));

    const clientUserData = ec2.UserData.forLinux();
    clientUserData.addCommands(
      "dnf install -y amazon-ssm-agent",
      "systemctl enable --now amazon-ssm-agent",
      "yum install -y golang",
      "mkdir -p /opt/app",
      `cat <<'EOF' >/opt/app/vpn_client.go
${vpnClientSrc}
EOF`,
      "cd /opt/app",
      "go build -o vpn_client vpn_client.go",
      "nohup ./vpn_client --listen :6000 --server 10.60.0.10:5000 --key secret >/var/log/vpn_client.log 2>&1 &"
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
      "dnf install -y amazon-ssm-agent",
      "systemctl enable --now amazon-ssm-agent",
      "yum install -y nc",
      "echo 'auto test packet' | nc -u 10.0.0.10 80"
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

    const backendEc2 = new ec2.Instance(this, "BackendEc2", {
      vpc: backendVpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: ec2.SecurityGroup.fromSecurityGroupId(
        this,
        "BackendDefaultSg",
        backendVpc.vpcDefaultSecurityGroup
      ),
      instanceType: new ec2.InstanceType("t3.micro"),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      userData: backendUserData,
      role: backendEc2Role,
    });

    //
    // Route: 10.0.0.10/32 → GWLBE
    //
    backendVpc.privateSubnets.forEach((subnet, i) => {
      new ec2.CfnRoute(this, `BackendToVip${i}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: "10.0.0.10/32",
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
