# Copy to dev.tfvars (git-ignored) and pass with -var-file=dev.tfvars.

region      = "ca-central-1"
stage       = "dev"
alarm_email = "you@example.com"

# Only once your account's Lambda concurrency limit has been raised above 10
# (Service Quotas -> AWS Lambda -> Concurrent executions):
# bulkhead_concurrency = { fares = 3, seatmaps = 2, holds = 1, ticket_worker = 2 }
