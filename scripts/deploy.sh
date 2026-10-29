#!/usr/bin/env bash
set -e

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== E-Junkie Automated Deployment Pipeline ===${NC}"

# Step 1: Run automated tests locally before deploying
echo -e "\n${YELLOW}Step 1: Running test suite...${NC}"
npm test
echo -e "${GREEN}✓ All 16 automated tests passed.${NC}"

# Step 2: Determine deployment target
echo -e "\n${YELLOW}Step 2: Checking deployment tools...${NC}"

if command -v fly &> /dev/null || command -v flyctl &> /dev/null; then
  FLY_BIN=$(command -v fly || command -v flyctl)
  echo -e "${GREEN}✓ Detected Fly.io CLI: ${FLY_BIN}${NC}"

  # Check if authenticated
  if ! $FLY_BIN auth whoami &> /dev/null; then
    echo -e "${YELLOW}Please authenticate with Fly.io:${NC}"
    $FLY_BIN auth login
  fi

  # Check if app exists
  APP_NAME=$(grep '^app = ' fly.toml | cut -d '"' -f 2 || echo "e-junkie")
  echo -e "Target Fly.io App: ${BLUE}${APP_NAME}${NC}"

  # Check or create persistent storage volume
  echo -e "Verifying persistent volume 'ejunkie_data'..."
  if ! $FLY_BIN volumes list -a "$APP_NAME" 2>/dev/null | grep -q "ejunkie_data"; then
    echo -e "${YELLOW}Creating persistent volume 'ejunkie_data' in primary region (bom - Mumbai)...${NC}"
    $FLY_BIN volumes create ejunkie_data --size 1 --region bom -a "$APP_NAME" -y
  else
    echo -e "${GREEN}✓ Persistent volume 'ejunkie_data' is ready.${NC}"
  fi

  # Deploy
  echo -e "\n${YELLOW}Step 3: Deploying container to Fly.io edge network...${NC}"
  $FLY_BIN deploy --remote-only

  echo -e "\n${GREEN}✓ Deployment completed successfully!${NC}"
  $FLY_BIN status -a "$APP_NAME"

elif command -v docker &> /dev/null; then
  echo -e "${GREEN}✓ Detected Docker.${NC}"
  echo -e "\n${YELLOW}Step 3: Building and starting production container...${NC}"
  docker compose up -d --build
  echo -e "\n${GREEN}✓ Docker container started successfully at http://localhost:3000${NC}"
  docker compose ps
else
  echo -e "${RED}Error: Neither flyctl nor docker was found.${NC}"
  echo -e "To automate Fly.io deployments, install flyctl: https://fly.io/docs/hands-on/install-flyctl/"
  echo -e "Alternatively, push to GitHub to let GitHub Actions automate the deployment for you."
  exit 1
fi

