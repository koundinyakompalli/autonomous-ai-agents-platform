# Specter Backend Configuration
# Remote state stored in S3 with DynamoDB locking

bucket         = "mhk-terraform-state"
key            = "specter/terraform.tfstate"
region         = "us-east-2"
dynamodb_table = "terraform_state_locking_table"
encrypt        = true

# Usage:
#   terraform init -backend-config=backend.hcl
#   terraform plan -var-file=terraform.tfvars
#   terraform apply -var-file=terraform.tfvars
#   terraform destroy -var-file=terraform.tfvars
