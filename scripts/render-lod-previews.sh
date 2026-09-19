#!/bin/sh
# Render six-view previews of every generated LOD GLB into docs/previews/lod/.
set -e
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
for glb in assets/generated/porsche/car_lod[0-9].glb; do
  name=$(basename "$glb" .glb)
  prefix=${name#car_}
  "$BLENDER" --background --python scripts/blender/render-previews.py -- \
    --glb "$glb" --out docs/previews/lod --prefix "$prefix" --size 1000 700 > /dev/null 2>&1 &
done
wait
echo "previews written to docs/previews/lod/"
