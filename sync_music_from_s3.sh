BUCKET=$1

if [ -z "$BUCKET" ]; then
  echo "Usage: $0 <bucket-name>"
  exit 1
fi

aws s3 sync s3://$BUCKET/8-bitbox-music-mp3/ public/music
