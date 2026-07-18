#!/usr/bin/env bash
# Deploy the Specter Dashboard to ECS
# Usage: ./deploy.sh [--infra]
#
# --infra   Also run terraform apply (first deploy only, or after infra changes)
# Default:  Build, push Docker image, force new ECS deployment

set -euo pipefail

AWS_REGION="us-east-2"
AWS_ACCOUNT="323960442001"
ECR_REPO="$AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/specter/dashboard"
ECS_CLUSTER="specter-cluster"
ECS_SERVICE="DASHBOARD"

echo "==> Authenticating with ECR..."
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"

echo "==> Building frontend + server..."
npm run build

echo "==> Building Docker image..."
docker build --platform linux/amd64 -t "$ECR_REPO:latest" .

echo "==> Pushing to ECR..."
docker push "$ECR_REPO:latest"

if [[ "${1:-}" == "--infra" ]]; then
  echo "==> Applying Terraform (infra)..."
  cd ../terraform
  terraform apply -target=aws_ecr_repository.dashboard \
                  -target=aws_ecs_task_definition.dashboard \
                  -target=aws_ecs_service.dashboard \
                  -target=aws_lb.dashboard \
                  -target=aws_lb_listener.dashboard_https \
                  -target=aws_lb_listener.dashboard_http_redirect \
                  -target=aws_lb_target_group.dashboard \
                  -target=aws_security_group.dashboard_alb \
                  -target=aws_security_group.dashboard_tasks \
                  -target=aws_security_group_rule.rds_from_dashboard \
                  -target=aws_iam_role.dashboard_task_role \
                  -target=aws_cloudwatch_log_group.dashboard \
                  -target=aws_route53_record.dashboard \
                  -auto-approve
  cd -
fi

echo "==> Forcing new ECS deployment..."
aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --force-new-deployment \
  --region "$AWS_REGION" \
  --output json | python3 -c "import sys,json; d=json.load(sys.stdin); print('Service:', d['service']['serviceName'], '| Desired:', d['service']['desiredCount'])"

echo ""
echo "==> Deployment triggered. Monitor at:"
echo "    https://console.aws.amazon.com/ecs/v2/clusters/$ECS_CLUSTER/services/$ECS_SERVICE"
echo ""
echo "==> Dashboard will be live at: https://productFactory.mhkdevsandbox.com"
