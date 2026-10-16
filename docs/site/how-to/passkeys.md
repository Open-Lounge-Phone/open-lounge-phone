---
title: Passkeys
description: Why accounts use passkeys instead of passwords, how to make one on any device (your phone, a security key or a password manager), your recovery code, and signing out lost devices.
sidebar:
  order: 3
---

Accounts on Open Lounge Phone servers have **no passwords**. You create your account, and sign in
later, with a **passkey**. This page explains what that is, why it's safer, and what to do if
your device doesn't have a fingerprint or face sign-in.

## What a passkey is

A passkey is a sign-in your device keeps for one website. You unlock it the same way you unlock
the device: your fingerprint, your face, or your screen lock PIN. There's nothing to type.

Behind the scenes it's a pair of keys. The private one stays locked inside your device (often in
its security chip), and the server gets only the public one. When you sign in, the server sends a
fresh challenge, your device signs it after you unlock it, and the server checks the signature.

## Why only passkeys

A password is a secret that both you and the server know, so it can leak from either side.
Passkeys remove that weakness:

- **Nothing to steal from the server.** The server keeps only your public key, which can check a
  sign-in but can't make one. If someone copied the server's whole database, they still couldn't
  sign in as you.
- **Nothing to phish.** A passkey only works on the site it was made for. A look-alike site
  can't ask for it, and you can't be tricked into typing it somewhere.
- **Nothing to guess or reuse.** There is no password to guess, to forget, or to reuse on
  another site that then gets hacked.
- **Your fingerprint or face stays with you.** They only unlock the passkey on your device. They
  never go to the server.

It also means the server needs no email address or phone number from you: no password resets, so
nothing to reset them with.

## Security keys (YubiKey and others)

A security key is a passkey you can hold: a small USB, USB-C or NFC key such as a YubiKey. It's
the strongest choice, and it's welcome everywhere you can use a passkey here:

- **It can't be copied.** The passkey is made inside the key and never leaves it, so nothing on
  your computer (not even malware) can take it.
- **It needs you.** It only signs you in when you touch it, and when you've set a PIN on it,
  only with that PIN.
- **It works on any computer.** Plug it in or tap it on your phone; no fingerprint reader or
  account with Apple, Google or Microsoft needed. Good for shared or older computers.

Use a key that can store passkeys (look for **FIDO2**, such as the YubiKey 5 or Security Key
series). Older keys that only do "U2F" can't, because accounts here have no username to type.
Register two keys, or a key and your phone, and keep one somewhere safe.

## Making a passkey on any device

When you create an account or add a passkey, your browser opens a window that offers the ways
your device supports. If yours has no fingerprint or face sign-in, any of these works:

| Option | How |
|---|---|
| **Your phone** | Choose "use a phone or tablet" (or "another device"). Your computer shows a QR code; scan it with your phone's camera and unlock the phone. The passkey is kept on your phone, and you'll use your phone the same way to sign in on that computer. Both need Bluetooth turned on. |
| **A security key** | A small USB, USB-C or NFC key that holds passkeys, such as a YubiKey, Google Titan Key or a Feitian key (look for "FIDO2"). Insert or tap it and touch it when asked. Good for shared or older computers. |
| **A password manager** | Managers that store passkeys and sync them across your devices: iCloud Keychain (Apple devices), Google Password Manager (Android and Chrome), Microsoft (Windows), 1Password, Bitwarden, Dashlane, Proton Pass, KeePassXC. |
| **Your computer's screen lock** | Windows Hello (PIN, face or fingerprint), Touch ID or your Mac's password, or a Chromebook's PIN. These work even without a fingerprint reader. |

Passkeys need a recent browser (Safari, Chrome, Edge or Firefox) and a server address that starts
with `https`. If the app says "This browser can't use passkeys here", open the page in another
browser or on your phone. If it says "this server's address doesn't match", you opened the server
at a different address than the one its passkeys belong to: use the address it names.

Signed in on a computer with your phone's passkey (by QR code)? The app then offers to add a
passkey on the computer too, so it can sign you in by itself next time. Skipping is fine.

If you join with an invite on a device that can't make a passkey, the app says so with a lasting
note: that device stays signed in for 90 days and then signs you out. Add a passkey before then
(on any device) or keep your recovery code.

## Don't get locked out

- **Add a second passkey.** In the app, open **Account → Your passkeys → Add a passkey** on
  another device, or with a security key. Passkeys kept in iCloud Keychain, Google Password Manager
  or another password manager also follow you to your other devices.
- **Keep your recovery code.** You get one when your account is made, shown once. Print it, or
  keep it in a password manager. If you have none (older accounts), the app reminds you: make one
  under **Account → Recovery code**. Making a new one stops the old one working.

## Your recovery code

The recovery code is 28 letters and digits in groups of four, like
`ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345`. With your handle, it gets you back in when every passkey
is lost:

1. On the sign-in screen choose **Lost your passkey?** (or open your server's address with
   `/#recover` at the end).
2. Enter your handle and the code.
3. Make a new passkey on this device. The old code is now used up.
4. You get a **new** recovery code: save it the same way.
5. Leave **Sign out everywhere else** on (the default) if a device was lost or someone else might
   have your passkey.

Keep it private: **anyone with your handle and this code can get into your account.** The server
keeps only a scrambled version of it, so it can't show it to you again, and it's never in any log
or download. A recovery is noted in the change history of each of your households and teams, and
your other open apps are told, so you'd notice one that wasn't you. Wrong tries are limited, so
nobody can guess it. There's no email or "contact us" recovery: the code is the way back.

**No code either?** If your account is only in one household or team, someone who manages it can
send you a **sign-in link** from the **People** page; open it and add a new passkey. A sign-in
link can't be made for someone who's also in other households or teams (it would open those too),
nor by others for the space's owner.

## Removing a passkey, and signing out a lost device

You can see and remove your passkeys under **Account → Your passkeys**. Removing one is
confirmed first. Your last passkey can go only if you have a recovery code, and then you'll need
the code to sign in again.

**Removing a passkey doesn't sign a lost device out.** A phone or computer that is already signed
in stays signed in until you end its session. After removing a passkey the app offers **Sign out
everywhere else**; you can also do it any time:

- **Account → Where you're signed in** lists every browser and app signed in to your account,
  when and how it signed in (a passkey, an invite, a sign-in link, the recovery code) and when it
  was last used. **Sign out** ends one; **Sign out everywhere else** ends all but this one. Their
  open app closes at once.
- A session you keep using lasts until 90 days after you last used it. One that no passkey backs
  ends 90 days after it started, and the app shows the date.
