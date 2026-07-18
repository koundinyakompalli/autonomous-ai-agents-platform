#!/bin/bash
#
# Specter Deployment Script
# Complete deployment to AWS ECS using Terraform
#

set -e

echo "========================================="
echo "Specter AI Agent Cluster - Deployment"
echo "========================================="
echo ""

# Build TypeScript
echo "📦 Building TypeScript..."
npm run build
echo "✅ Build complete"
echo ""

# Build Docker images
echo "🐳 Building Docker images..."

# Orchestrator
docker build --platform linux/amd64 -f Dockerfile.orchestrator -t specter/orchestrator:latest .
echo "✅ Orchestrator image built"

# Workers (using unified Dockerfile with build args)
docker build --platform linux/amd64 -f Dockerfile.worker --build-arg AGENT_NAME=DARCI -t specter/darci-worker:latest .
echo "✅ DARCI worker image built"

docker build --platform linux/amd64 -f Dockerfile.worker --build-arg AGENT_NAME=SCRIBE -t specter/scribe-worker:latest .
echo "✅ SCRIBE worker image built"

docker build --platform linux/amd64 -f Dockerfile.worker --build-arg AGENT_NAME=PRISM -t specter/prism-worker:latest .
echo "✅ PRISM worker image built"

docker build --platform linux/amd64 -f Dockerfile.worker --build-arg AGENT_NAME=HERMES -t specter/hermes-worker:latest .
echo "✅ HERMES worker image built"

echo ""
echo "🚀 Initializing Terraform..."
cd terraform
terraform init

echo ""
echo "📋 Planning Terraform changes..."
terraform plan -out=tfplan

echo ""
echo "⚠️  Review the plan above. Press Enter to apply, or Ctrl+C to cancel..."
read

echo ""
echo "🚀 Applying Terraform configuration..."
terraform apply tfplan

echo ""
echo "✅ Terraform applied!"
echo ""

# Get ECR URLs
ORCHESTRATOR_ECR=$(terraform output -raw orchestrator_ecr_url)

echo "📤 Pushing images to ECR..."
echo "ECR URLs from Terraform outputs:"
echo "  Orchestrator: $ORCHESTRATOR_ECR"
echo ""

# ECR login
echo "Logging into ECR..."
aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin 323960442001.dkr.ecr.us-east-2.amazonaws.com

# Tag and push orchestrator
docker tag specter/orchestrator:latest $ORCHESTRATOR_ECR:latest
docker push $ORCHESTRATOR_ECR:latest
echo "✅ Orchestrator pushed"

# Tag and push workers
DARCI_ECR="323960442001.dkr.ecr.us-east-2.amazonaws.com/specter/darci-worker"
SCRIBE_ECR="323960442001.dkr.ecr.us-east-2.amazonaws.com/specter/scribe-worker"
PRISM_ECR="323960442001.dkr.ecr.us-east-2.amazonaws.com/specter/prism-worker"
HERMES_ECR="323960442001.dkr.ecr.us-east-2.amazonaws.com/specter/hermes-worker"

docker tag specter/darci-worker:latest $DARCI_ECR:latest
docker push $DARCI_ECR:latest
echo "✅ DARCI worker pushed"

docker tag specter/scribe-worker:latest $SCRIBE_ECR:latest
docker push $SCRIBE_ECR:latest
echo "✅ SCRIBE worker pushed"

docker tag specter/prism-worker:latest $PRISM_ECR:latest
docker push $PRISM_ECR:latest
echo "✅ PRISM worker pushed"

docker tag specter/hermes-worker:latest $HERMES_ECR:latest
docker push $HERMES_ECR:latest
echo "✅ HERMES worker pushed"

echo ""
echo "========================================="
echo "✅ Deployment Complete!"
echo "========================================="
echo ""
echo "Services deployed:"
echo "  - specter-orchestrator (1 instance)"
echo "  - specter-darci-worker (2 instances)"
echo "  - specter-scribe-worker (1 instance)"
echo "  - specter-prism-worker (1 instance)"
echo "  - specter-hermes-worker (1 instance)"
echo ""
echo "Next steps:"
echo "1. Check service status: aws ecs list-services --cluster specter-cluster --region us-east-2"
echo "2. View logs: aws logs tail /ecs/specter/orchestrator --follow --region us-east-2"
echo "3. Create test JIRA ticket with DARCI label"
echo "4. Monitor task execution in database"
echo ""
echo "🎉 Specter is live!"
