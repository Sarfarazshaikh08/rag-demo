# AWS S3 Frontend + EC2 Backend Deployment

This guide deploys:

- Frontend: static files from `frontend/dist` to Amazon S3 static website hosting, optionally under a prefix such as `/rag`.
- Backend: Node/Express API from `backend/index.js` on an EC2 instance.

AWS references:

- Amazon S3 can host static websites with client-side scripts.
- Public S3 website buckets require public read access or a CloudFront distribution.
- CORS is required when browser code calls a different origin.

## 1. Backend URL And Cookie Rule

If the frontend is on S3/CloudFront and the API is on EC2, they are different origins.

For login cookies to work cross-origin, use HTTPS on the backend and set:

```bash
SESSION_COOKIE_SAMESITE=None
SESSION_COOKIE_SECURE=true
CORS_ORIGIN=https://<your-frontend-domain>
```

For a quick HTTP-only internal test, cookies may not behave correctly across origins. Use same-origin local dev or put HTTPS in front of EC2 before testing auth from S3.

## 2. Build Frontend For S3

Set the API base to your EC2 backend URL:

```bash
FRONTEND_API_BASE=https://api.example.com npm run frontend:build
```

Output:

```text
frontend/dist/index.html
frontend/dist/config.js
frontend/dist/solvagence-logo.png
```

`config.js` contains:

```js
window.KNOWLEDGEOPS_API_BASE = "https://api.example.com";
```

The frontend uses relative asset paths, so it can be hosted at the domain root or under a path:

```text
https://demo.solvagence.com/
https://demo.solvagence.com/rag/
```

## 3. Create S3 Static Website

Create a bucket:

```bash
aws s3 mb s3://<frontend-bucket-name> --region <region>
```

Enable static website hosting:

```bash
aws s3 website s3://<frontend-bucket-name> --index-document index.html --error-document index.html
```

If using S3 website hosting directly, make the bucket public for read-only website objects. Update and apply:

```bash
deploy/aws/s3/bucket-policy-public-website.json
```

Replace `YOUR_FRONTEND_BUCKET_NAME`, then:

```bash
aws s3api put-bucket-policy \
  --bucket <frontend-bucket-name> \
  --policy file://deploy/aws/s3/bucket-policy-public-website.json
```

Deploy:

```bash
S3_FRONTEND_BUCKET=<frontend-bucket-name> \
S3_FRONTEND_PREFIX=rag \
FRONTEND_API_BASE=https://api.example.com \
npm run frontend:deploy:s3
```

With `S3_FRONTEND_PREFIX=rag`, files are uploaded to:

```text
s3://<frontend-bucket-name>/rag/
```

Use this for:

```text
https://demo.solvagence.com/rag/
```

Important: plain S3 website hosting and browsers treat `/rag` and `/rag/` differently. For the clean URL `https://demo.solvagence.com/rag`, configure CloudFront to redirect `/rag` to `/rag/` or rewrite `/rag` to `/rag/index.html`.

## 4. Prepare EC2

Recommended baseline:

- Ubuntu 22.04/24.04 or Amazon Linux 2023.
- Security group inbound:
  - `22` from your IP.
  - `80` and `443` from the internet.
- Node.js 20+.
- nginx as reverse proxy.
- HTTPS certificate for `api.example.com`.

Create app user and directories:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin solvagence
sudo mkdir -p /opt/solvagence-rag /etc/solvagence-rag
sudo chown -R solvagence:solvagence /opt/solvagence-rag
```

Upload or clone this repo into:

```text
/opt/solvagence-rag
```

Install dependencies:

```bash
cd /opt/solvagence-rag
npm ci --omit=dev
```

Create backend env:

```bash
sudo cp deploy/aws/ec2/backend.env.example /etc/solvagence-rag/backend.env
sudo nano /etc/solvagence-rag/backend.env
```

Set at minimum:

```bash
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
CORS_ORIGIN=https://<frontend-domain>
SESSION_COOKIE_SAMESITE=None
SESSION_COOKIE_SECURE=true
ADMIN_PASSWORD_HASH=<bcrypt-hash>
REVIEWER_PASSWORD_HASH=<bcrypt-hash>
VIEWER_PASSWORD_HASH=<bcrypt-hash>
```

Generate hashes locally or on EC2:

```bash
npm run password:hash -- StrongPassword123
```

## 5. Install systemd Service

```bash
sudo cp deploy/aws/ec2/solvagence-rag.service /etc/systemd/system/solvagence-rag.service
sudo systemctl daemon-reload
sudo systemctl enable solvagence-rag
sudo systemctl start solvagence-rag
sudo systemctl status solvagence-rag
```

Check:

```bash
curl http://127.0.0.1:3000/health
```

## 6. Configure nginx

Copy template:

```bash
sudo cp deploy/aws/ec2/nginx.conf /etc/nginx/sites-available/solvagence-rag
sudo ln -s /etc/nginx/sites-available/solvagence-rag /etc/nginx/sites-enabled/solvagence-rag
```

Edit:

```bash
sudo nano /etc/nginx/sites-available/solvagence-rag
```

Replace:

```text
api.example.com
```

Test and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Add HTTPS before production auth testing. If using Certbot:

```bash
sudo certbot --nginx -d api.example.com
```

## 7. Verify End To End

Backend:

```bash
curl https://api.example.com/health
curl https://api.example.com/api/status
```

Frontend:

Open the S3 website endpoint, CloudFront URL, or custom frontend domain.

Ask:

```text
What is the SLA for a P1 support issue?
```

Expected:

- Cited answer with `[S1]`.
- Source panel shows `keyword-bm25`, BM25 score, evidence type.
- Login works only if backend is HTTPS and cookie settings are `SameSite=None; Secure`.

## 8. Recommended Production Upgrade

S3 website hosting is fine for a demo, but for production prefer:

- CloudFront in front of S3.
- HTTPS custom frontend domain.
- HTTPS custom backend domain.
- RDS PostgreSQL for users/documents/audit.
- S3 object storage for uploaded originals.
- EC2 instance role with least-privilege S3 access.
