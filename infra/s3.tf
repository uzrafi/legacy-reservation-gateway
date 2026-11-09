# ------------------------------------------------------------ FAREDUMP exports (private)
resource "aws_s3_bucket" "exports" {
  bucket        = "${local.name}-faredump-${local.account}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "exports" {
  bucket                  = aws_s3_bucket.exports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id
  rule {
    id     = "expire-old-dumps"
    status = "Enabled"
    filter { prefix = "exports/" }
    expiration { days = 14 }
  }
}

resource "aws_s3_bucket_notification" "exports" {
  bucket = aws_s3_bucket.exports.id
  lambda_function {
    lambda_function_arn = module.fare_loader.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "exports/"
    filter_suffix       = ".csv"
  }
  depends_on = [aws_lambda_permission.s3_invoke_loader]
}

# ------------------------------------------------------------ Swagger UI (public static site)
resource "aws_s3_bucket" "docs" {
  bucket        = "${local.name}-api-docs-${local.account}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "docs" {
  bucket                  = aws_s3_bucket.docs.id
  block_public_acls       = true
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false
}

resource "aws_s3_bucket_website_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id
  index_document { suffix = "index.html" }
}

data "aws_iam_policy_document" "docs_public" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.docs.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "docs" {
  bucket     = aws_s3_bucket.docs.id
  policy     = data.aws_iam_policy_document.docs_public.json
  depends_on = [aws_s3_bucket_public_access_block.docs]
}

resource "aws_s3_object" "docs_index" {
  bucket       = aws_s3_bucket.docs.id
  key          = "index.html"
  source       = "${path.module}/../docs/swagger/index.html"
  etag         = filemd5("${path.module}/../docs/swagger/index.html")
  content_type = "text/html"
}

resource "aws_s3_object" "docs_spec" {
  bucket       = aws_s3_bucket.docs.id
  key          = "openapi.yaml"
  source       = "${path.module}/../openapi/openapi.yaml"
  etag         = filemd5("${path.module}/../openapi/openapi.yaml")
  content_type = "application/yaml"
}
