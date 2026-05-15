#!/bin/sh
set -e

echo "Running prisma db push..."
npx prisma db push --skip-generate

echo "Starting Next.js..."
exec node server.js
