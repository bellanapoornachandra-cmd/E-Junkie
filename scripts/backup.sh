#!/usr/bin/env bash
set -e

BACKUP_DIR="${BACKUP_DIR:-./backups}"
DB_FILE="${EJ_DB:-./data/ejunkie.db}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/ejunkie_${TIMESTAMP}.db"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_FILE" ]; then
  echo "Database file $DB_FILE not found. Nothing to backup."
  exit 0
fi

echo "Creating safe atomic backup of ${DB_FILE}..."

# Use node with node:sqlite to execute a safe VACUUM INTO backup
node --no-warnings=ExperimentalWarning -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('$DB_FILE');
db.exec(\"VACUUM INTO '$BACKUP_FILE'\");
console.log('Backup saved to: $BACKUP_FILE');
"

# Keep only the last 14 backups to conserve space
find "$BACKUP_DIR" -name "ejunkie_*.db" -type f | sort -r | tail -n +15 | xargs -r rm -f

echo "Backup complete. Retained the latest 14 snapshots in ${BACKUP_DIR}."

