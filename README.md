# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template

# Demo実行手順

## 必要なツール群のインストール

* Node.js/NPM
* aws cli
* cdk
* session-manager-plugin

## デプロイ

```bash
aws configure --profile gwlb-demo
cdk bootstrap --profile gwlb-demo
cdk deploy --profile gwlb-demo --require-approval never
```

## 動作確認

* Backend

SSM経由で接続

```powershell
aws ssm start-session --profile gwlb-demo \
  --target $(aws ec2 describe-instances --profile gwlb-demo \
    --filters "Name=tag:Name,Values=*BackendEc2*" "Name=instance-state-name,Values=running" \
    --query "Reservations[0].Instances[0].InstanceId" --output text)
```

インストールのコンソール上で以下を個別に実行

```sh
echo 'auto test packet' | ncat -u 10.0.0.10 80
```

```sh
sudo tcpdump -i any -n 'dst host 10.0.0.10' -v -X
```

* OverlayGW

SSM経由で接続

```powershell
aws ssm start-session --profile gwlb-demo \
  --target $(aws ec2 describe-instances --profile gwlb-demo \
    --filters "Name=tag:Name,Values=*OverlayGateway*" "Name=instance-state-name,Values=running" \
    --query "Reservations[0].Instances[0].InstanceId" --output text)
```

インストールのコンソール上で以下を個別に実行

```sh
tail -f /var/log/vpn_server.log
```

```sh
sudo tcpdump -i any -n '(port 6081 or port 5000)' -v
```

* VPN Client

SSM経由で接続

```powershell
aws ssm start-session --profile gwlb-demo \
  --target $(aws ec2 describe-instances --profile gwlb-demo \
    --filters "Name=tag:Name,Values=*VpnClient*" "Name=instance-state-name,Values=running" \
    --query "Reservations[0].Instances[0].InstanceId" --output text)
```

インストールのコンソール上で以下を個別に実行

```sh
tail -f /var/log/vpn_client.log
```

```sh
sudo tcpdump -i any -n port 6000 -v -A
```

### WireGuard Overlay

OverlayGateway と VpnClient 間には WireGuard で `10.0.0.0/16` の仮想ネットワークを張っています。双方で以下を実行するとトンネル状態を確認できます。

```sh
sudo wg show
ip addr show wg0
```

## Clean up

```bash
cdk destroy --profile gwlb-demo
```
