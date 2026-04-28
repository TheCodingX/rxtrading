# RX Trading — Firebase Setup Guide

## 1. Create Firebase Project
1. Go to https://console.firebase.google.com/
2. Click "Add Project" → Name it "rxtrading-app"
3. Disable Google Analytics (optional)
4. Click "Create Project"

## 2. Enable Google Authentication
1. In Firebase Console → Authentication → Sign-in method
2. Click "Google" → Enable it
3. Set project support email
4. Click Save

## 3. Enable Firestore
1. In Firebase Console → Firestore Database
2. Click "Create Database"
3. Choose "Start in production mode"
4. Select region (us-central1 recommended)
5. After created, go to Rules tab and paste:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Users can only read/write their own data
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;

      match /data/{docId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }

    // Admin-only: VIP management (use Firebase Admin SDK or Console)
    match /vipEmails/{email} {
      allow read: if request.auth != null;
      allow write: if false; // Only admin
    }
  }
}
```

## 4. Get Firebase Config
1. In Firebase Console → Project Settings (gear icon)
2. Scroll to "Your apps" → Click web icon (</>)
3. Register app name: "RX Trading Web"
4. Copy the firebaseConfig object
5. Replace FIREBASE_CONFIG in app.html with your values

## 5. Add Authorized Domains
1. In Firebase Console → Authentication → Settings
2. Under "Authorized domains", add:
   - rxtrading.net
   - www.rxtrading.net
   - localhost

## 6. Grant VIP to a Google Account
In Firebase Console → Firestore → users collection:
1. Find the user document (by UID)
2. Set field `vip` = true
3. Set field `vipCode` = "RX-VIP-GOOGLE"
4. Set field `vipName` = "User Name"
5. (Optional) Set `vipExpiresAt` = timestamp
