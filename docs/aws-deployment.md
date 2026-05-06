# AWS Deployment

Recommended demo-grade production shape for a new AWS deployment:

- App runtime: Amazon ECS Fargate running the Docker image from this repo.
- Load balancer: Application Load Balancer with `/health` health checks.
- Database: Amazon RDS for PostgreSQL.
- Original files: Amazon S3 with `OBJECT_STORAGE_PROVIDER=s3`.
- Secrets: AWS Secrets Manager or SSM Parameter Store.
- Access: ECS task role with S3 permissions.

AWS App Runner is simpler, but AWS documentation says it is no longer open to new customers after April 30, 2026. Use App Runner only if your AWS account already has access. ECS Fargate is the safer production choice.

## 1. Prepare Environment Variables

Use these values in the ECS task definition. Do not commit real secrets.

```bash
NODE_ENV=production
HOST=0.0.0.0
ENABLE_GEMINI=true
GEMINI_API_KEY=<from-secrets-manager>
GEMINI_MODEL=gemini-2.5-flash
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=<bcrypt-hash>
REVIEWER_USER=reviewer
REVIEWER_PASSWORD_HASH=<bcrypt-hash>
VIEWER_USER=viewer
VIEWER_PASSWORD_HASH=<bcrypt-hash>
ENABLE_POSTGRES=true
DATABASE_URL=postgres://<user>:<password>@<rds-endpoint>:5432/<db>
OBJECT_STORAGE_PROVIDER=s3
AWS_REGION=<aws-region>
S3_BUCKET=<bucket-name>
S3_PREFIX=rag-demo/originals
OCR_ENABLED=false
```

Create hashes locally:

```bash
npm run password:hash -- StrongPassword123
```

## 2. Create AWS Resources

1. Create an S3 bucket for original uploads.
2. Create RDS PostgreSQL in private subnets.
3. Create an ECR repository for the Docker image.
4. Create an ECS cluster with Fargate capacity.
5. Create an Application Load Balancer in public subnets.
6. Create an ECS service in private subnets.
7. Create a security group allowing PostgreSQL port `5432` from the ECS service security group.
8. Create an ECS task role with permission to write objects to the S3 bucket.

Minimum S3 permission for the ECS task role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::<bucket-name>/rag-demo/originals/*"
    }
  ]
}
```

## 3. Initialize Database

From a machine that can reach RDS:

```bash
npm run db:init
npm run db:seed-users
```

## 4. Build and Push Image

```bash
docker build -t rag-demo .
aws ecr create-repository --repository-name rag-demo
aws ecr get-login-password --region <aws-region> | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<aws-region>.amazonaws.com
docker tag rag-demo:latest <account-id>.dkr.ecr.<aws-region>.amazonaws.com/rag-demo:latest
docker push <account-id>.dkr.ecr.<aws-region>.amazonaws.com/rag-demo:latest
```

## 5. Deploy ECS Fargate

1. Create an ECS task definition using the ECR image.
2. Container port: `3000`.
3. CPU/memory for demo: `0.5 vCPU / 1 GB`.
4. Add environment variables and secrets.
5. Attach the ECS task role with S3 access.
6. Create an ECS service behind the Application Load Balancer.
7. Configure ALB health check path: `/health`.

## 6. Optional App Runner Path

Only use this if your AWS account already has App Runner access.

1. Create App Runner service from the ECR image.
2. Set service port to `3000`.
3. Health check path: `/health`.
4. Attach a VPC connector so App Runner can reach RDS.
5. Add environment variables and secrets.
6. Attach an instance role with S3 permissions.

## 7. Demo Checklist

- Open `/health` and confirm `ok: true`.
- Login as admin.
- Upload a document. It should be Draft and not searchable.
- Add reviewer comment.
- Approve as admin.
- Ask a question and confirm the answer cites the approved document.
- Export audit logs.
