# One-time notarization setup on a new Mac

The scripts use the keychain profile `notary-profile1`. Create it once:

    xcrun notarytool store-credentials notary-profile1 \
      --apple-id <your-apple-id> --team-id TCT2QHH9TG \
      --password <app-specific-password>

(App-specific password from appleid.apple.com → Sign-In & Security.)
Then: ./sign.sh && ./dmg.sh
