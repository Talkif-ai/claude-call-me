// A passkey's assertions over an approval, made once with node:crypto (ECDSA is
// randomized, so this is a fixture, not a regenerated vector). Approval id
// 0192f000-0000-7000-8000-0000000000a9, action hash "ACTION"; site talkif.ai.
export const OWNER_APPROVAL_ID = '0192f000-0000-7000-8000-0000000000a9'
export const OWNER_FIXTURES = {
  "ES256": {
    "cose": "pQECAyYgASFYIPstSKMlq0kDK1qWFSNaMwZ0aEzzNSOS3lYY0B8NDfXOIlggq6bKeOIHGu6vaIATbDcwFjD_dmPoBl4sRnQWGhnh2pY",
    "valid": {
      "authenticatorData": "yMCP1ZSfdLDx5o4wZpg4CbonAvSwCopK0oRey9li7SYFAAAAAQ",
      "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoidk5rX3pTYjE1d3psbDFlUy1Vdk9pYjdwSlFjalBiMDF3R1RwdTR2cXNoSSIsIm9yaWdpbiI6Imh0dHBzOi8vYXBwLnRhbGtpZi5haSIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
      "signature": "MEUCIQDl8TF3ZHW8qEBTPaO-K7A2D384AbJvN-tW_I4Pof06UgIgOzVjLhmux2mejzIXDkspPSlj8iaILaQw8EBZkw5zzts"
    },
    "wrongChallenge": {
      "authenticatorData": "yMCP1ZSfdLDx5o4wZpg4CbonAvSwCopK0oRey9li7SYFAAAAAQ",
      "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoid0pGOGpnbFVvOGtLQk00Y2JRMHU0SEt6T2k0VjFwMzQxdmVYUzJxVDE4SSIsIm9yaWdpbiI6Imh0dHBzOi8vYXBwLnRhbGtpZi5haSIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
      "signature": "MEYCIQDNeI6dyhqq6Wt5tVYdSvQm_XVsvjlsNMrcKn_WqFO3AgIhAJY4gx1igRvpD8VoNVTJvfI_8P3CUw3Ih5MC1warYoSx"
    },
    "wrongOrigin": {
      "authenticatorData": "yMCP1ZSfdLDx5o4wZpg4CbonAvSwCopK0oRey9li7SYFAAAAAQ",
      "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoidk5rX3pTYjE1d3psbDFlUy1Vdk9pYjdwSlFjalBiMDF3R1RwdTR2cXNoSSIsIm9yaWdpbiI6Imh0dHBzOi8vZXZpbC5leGFtcGxlIiwiY3Jvc3NPcmlnaW4iOmZhbHNlfQ",
      "signature": "MEUCIQDrpdp13tHYg14MGVgN4391-VXRxNRFxzHtZk9RizuhfQIgKmwLuhd1WRau_TE-_-Pv8xvq1I7F9j49Gv83jUoCHzc"
    },
    "noUv": {
      "authenticatorData": "yMCP1ZSfdLDx5o4wZpg4CbonAvSwCopK0oRey9li7SYBAAAAAQ",
      "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoidk5rX3pTYjE1d3psbDFlUy1Vdk9pYjdwSlFjalBiMDF3R1RwdTR2cXNoSSIsIm9yaWdpbiI6Imh0dHBzOi8vYXBwLnRhbGtpZi5haSIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
      "signature": "MEUCIH9Q0np1M6h6yT9VGB_gUSn7Vqucs18v02Dof94quuGjAiEArT3FIQ0oCjKb2Y00xizfgDQJys1IXaQ0lGPHwhvO1as"
    },
    "wrongRp": {
      "authenticatorData": "nBgN4M1pnueIl8R8_bPn7h11kG4xt3RqR0fepTaQmDcFAAAAAQ",
      "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoidk5rX3pTYjE1d3psbDFlUy1Vdk9pYjdwSlFjalBiMDF3R1RwdTR2cXNoSSIsIm9yaWdpbiI6Imh0dHBzOi8vYXBwLnRhbGtpZi5haSIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
      "signature": "MEYCIQCc1i2mG3COjsWcr3McibDQQLYbtkpx_ySkxkDaFExpCgIhAMgT4SDSJ3DgIRBMmwd3AChtBmcSQ5pUIag0dRDhWyS6"
    }
  },
  "EdDSA": {
    "cose": "pAEBAycgBiFYIE--PGRBz5s3x91c1Y7531z3vckmBoLFLHpZuzH7mXhR",
    "valid": {
      "authenticatorData": "yMCP1ZSfdLDx5o4wZpg4CbonAvSwCopK0oRey9li7SYFAAAAAQ",
      "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoidk5rX3pTYjE1d3psbDFlUy1Vdk9pYjdwSlFjalBiMDF3R1RwdTR2cXNoSSIsIm9yaWdpbiI6Imh0dHBzOi8vYXBwLnRhbGtpZi5haSIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
      "signature": "QPgZUXIawxshNhygbXMY26Up9gwo9bPf6Oub7CvZ8icouhNwxJ3cykgbfL75HDcPPlBdCiKPz2eI114_L-2uCw"
    },
    "wrongChallenge": {
      "authenticatorData": "yMCP1ZSfdLDx5o4wZpg4CbonAvSwCopK0oRey9li7SYFAAAAAQ",
      "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoid0pGOGpnbFVvOGtLQk00Y2JRMHU0SEt6T2k0VjFwMzQxdmVYUzJxVDE4SSIsIm9yaWdpbiI6Imh0dHBzOi8vYXBwLnRhbGtpZi5haSIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
      "signature": "xRM_gAlWvsDSu9RwLCDgl-EGFVh-pbNNSOt2SfJgWbU96QXkANhAjjZRC_5yAg9R3y2fc7XBFP5JNw3aqgr3Cg"
    },
    "wrongOrigin": {
      "authenticatorData": "yMCP1ZSfdLDx5o4wZpg4CbonAvSwCopK0oRey9li7SYFAAAAAQ",
      "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoidk5rX3pTYjE1d3psbDFlUy1Vdk9pYjdwSlFjalBiMDF3R1RwdTR2cXNoSSIsIm9yaWdpbiI6Imh0dHBzOi8vZXZpbC5leGFtcGxlIiwiY3Jvc3NPcmlnaW4iOmZhbHNlfQ",
      "signature": "0W7vJxNuoTij7FqcPHZyxjOrpLuhlKxRSvWkmWKLeuSKtY1aYWFUBYy3s3X72OAK2KfSNmgbKczC6cdZjZOECA"
    },
    "noUv": {
      "authenticatorData": "yMCP1ZSfdLDx5o4wZpg4CbonAvSwCopK0oRey9li7SYBAAAAAQ",
      "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoidk5rX3pTYjE1d3psbDFlUy1Vdk9pYjdwSlFjalBiMDF3R1RwdTR2cXNoSSIsIm9yaWdpbiI6Imh0dHBzOi8vYXBwLnRhbGtpZi5haSIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
      "signature": "9-_lOw8xLUS9gThXCxpuPqReQOTHpJtEsm0R0ddAez2GwYPsvv0A-MEa7F2Y0PQh_s77zpXBhFIgxLOlrdnYAA"
    },
    "wrongRp": {
      "authenticatorData": "nBgN4M1pnueIl8R8_bPn7h11kG4xt3RqR0fepTaQmDcFAAAAAQ",
      "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoidk5rX3pTYjE1d3psbDFlUy1Vdk9pYjdwSlFjalBiMDF3R1RwdTR2cXNoSSIsIm9yaWdpbiI6Imh0dHBzOi8vYXBwLnRhbGtpZi5haSIsImNyb3NzT3JpZ2luIjpmYWxzZX0",
      "signature": "a21hZ4nAAibeLaglhwDZI_VN9oF99jh8BKFVVyfgoMpeSCpD0ZVAViuDQXU997Di_sx4xtRQdEA81bxDWVheCA"
    }
  }
} as const
