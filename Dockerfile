# 1. Base image (Linux + Node 18 + OpenSSL 3)
FROM node:18-bullseye-slim

# 2. Install OpenSSL (مهم لـ Prisma)
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# 3. Set work directory
WORKDIR /app

# 4. Copy package files
COPY package*.json ./

# 5. Install dependencies
RUN npm install

# 6. Copy prisma schema
COPY prisma ./prisma

# 7. Generate Prisma Client (Linux)
RUN npx prisma generate

# 8. Copy rest of the app
COPY src ./src

# 9. Expose port
EXPOSE 8000

# 10. Start app
CMD ["node", "src/index.js"]
