output "api_base_url" {
  value = aws_api_gateway_stage.stage.invoke_url
}

output "api_keys" {
  description = "terraform output -json api_keys"
  value       = { for k, v in aws_api_gateway_api_key.partner : k => v.value }
  sensitive   = true
}

output "api_key_ids" {
  value = { for k, v in aws_api_gateway_api_key.partner : k => v.id }
}

output "legacy_url" {
  description = "SOAP endpoint of the simulated legacy host (WSDL: <url>reslink?wsdl)"
  value       = aws_lambda_function_url.legacy.function_url
}

output "legacy_admin_token" {
  value     = random_password.legacy_admin.result
  sensitive = true
}

output "legacy_password" {
  value     = random_password.legacy.result
  sensitive = true
}

output "jwt_private_key_param" {
  value = aws_ssm_parameter.jwt_private_key.name
}

output "fares_function_name" {
  value = module.fares.function_name
}

output "state_machine_arn" {
  value = aws_sfn_state_machine.ticketing.arn
}

output "swagger_ui_url" {
  value = "http://${aws_s3_bucket_website_configuration.docs.website_endpoint}"
}

output "dashboard_url" {
  value = "https://${local.region}.console.aws.amazon.com/cloudwatch/home?region=${local.region}#dashboards/dashboard/${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "canary_alarm_names" {
  value = [aws_cloudwatch_metric_alarm.api_5xx.alarm_name, aws_cloudwatch_metric_alarm.shadow_mismatch.alarm_name]
}
