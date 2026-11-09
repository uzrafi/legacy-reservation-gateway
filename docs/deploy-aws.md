# Deploying to AWS

Expected cost: about $0-5 in total if you keep to test volumes and run `terraform destroy`
when finished (see the cost table in the README).

## 0. Tools

| Tool | Install (Windows) | Check |
|---|---|---|
| Node.js 22+ | `winget install OpenJS.NodeJS.LTS` | `node -v` |
| Terraform 1.10+ | `winget install Hashicorp.Terraform` | `terraform -version` |
| AWS CLI v2 | `winget install Amazon.AWSCLI` | `aws --version` |
| k6 | `winget install k6` | `k6 version` |

## 1. AWS account set-up (once)

1. Sign in to the AWS console with the root user only to create an admin user for yourself in
   **IAM Identity Center** (or an IAM user), then stop using root.
2. `aws configure sso` (Identity Center) or `aws configure` (IAM user access key), region
   `ca-central-1`. Check with `aws sts get-caller-identity`.
3. Check the Lambda concurrency limit: `aws lambda get-account-settings --query AccountLimit`.
   If `ConcurrentExecutions` is 10, request 1000 in **Service Quotas > AWS Lambda >
   Concurrent executions** (free; often approved within a day). The stack works at 10, but
   you cannot enable the bulkhead and load tests will be throttled sooner.

## 2. Bootstrap: state bucket, GitHub OIDC roles, $5 budget

```bash
cd infra/bootstrap
terraform init
terraform apply -var budget_email=you@example.com
terraform output -raw backend_hcl > ../backend.hcl
```

If the account already has a GitHub OIDC provider, add `-var create_oidc_provider=false`.

## 3. Build and deploy

```bash
npm ci
npm run build
cd infra
terraform init -backend-config=backend.hcl
terraform apply
```

The first apply also runs the legacy host's FAREDUMP export once, which loads the modern
fares table through S3 and the loader Lambda.

Useful outputs:

```bash
terraform output api_base_url
terraform output -json api_keys
terraform output swagger_ui_url
terraform output dashboard_url
```

## 4. Call it

```bash
TOKEN=$(npx tsx scripts/issue-token.ts --ssm /lrg/dev/auth/private-key --sub me)
KEY=$(terraform -chdir=infra output -json api_keys | jq -r '."partner-basic"')
curl -s -H "x-api-key: $KEY" -H "Authorization: Bearer $TOKEN" \
  "$(terraform -chdir=infra output -raw api_base_url)/fares?origin=YYZ&destination=YVR&date=2026-12-01"
```

## 5. CI/CD with GitHub OIDC

In the GitHub repository, **Settings > Secrets and variables > Actions > Variables**:

| Variable | Value |
|---|---|
| `AWS_REGION` | `ca-central-1` |
| `TF_STATE_BUCKET` | `terraform -chdir=infra/bootstrap output -raw state_bucket` |
| `AWS_PLAN_ROLE_ARN` | `terraform -chdir=infra/bootstrap output -raw plan_role_arn` |
| `AWS_DEPLOY_ROLE_ARN` | `terraform -chdir=infra/bootstrap output -raw deploy_role_arn` |

Then: pull requests run lint, tests, `terraform fmt/validate/plan` (read-only role); pushes to
`main` run `terraform apply` with the deploy role and the integration tests against the stage.
Until the variables exist, CI simply skips the AWS steps.

## 6. Measure

```bash
npm run experiments -- --target aws
```

Writes `results/aws/*.json` and `docs/results-aws.md`. It takes about 45 minutes and makes
roughly 30 000 API calls (a few cents). It includes the usage-plan throttling test and runs the
strangler-fig shadow comparison and the canary against the real Lambda alias.

## 7. Tear down

```bash
terraform -chdir=infra destroy
```

Then empty and delete the state bucket by hand (`lrg-tfstate-<account>`), and
`terraform -chdir=infra/bootstrap destroy` if you no longer need the CI roles or budget.
