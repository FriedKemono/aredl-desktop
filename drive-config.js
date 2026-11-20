// Intentionally empty: GitHub blocks pushes that contain OAuth secrets.
// The Google OAuth client built into the app comes from drive-config.local.js (git-ignored). On GitHub, the build
// writes that file from the repository secrets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
module.exports = { clientId: '', clientSecret: '' };
