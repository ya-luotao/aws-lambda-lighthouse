# aws-lambda-lighthouse

## Deploy

- `yarn` to install dependencies inside each of the `lambdas/src` directiories.
- Change the `locals` block in `infra.tf` as needed for your org name, region, creds file path, etc.
- `terraform init`
- `terraform plan`
- `terraform apply`
