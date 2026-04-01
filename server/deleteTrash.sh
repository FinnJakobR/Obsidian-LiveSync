#!/bin/bash

for dir in /backup/*; do
  if [ -d "$dir/.trash" ]; then
    rm -rf "$dir/.trash"
    echo "Deleted: $dir/.trash"
  fi