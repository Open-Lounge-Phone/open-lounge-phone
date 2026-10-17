---
title: Run it offline
description: A server on your own network with no internet at all — what works, what doesn't, and the HTTPS and naming steps that make browsers allow calls.
sidebar:
  order: 12
---

Your own server can carry calls on a network with no internet connection: a house, a cabin, a
boat, a building that keeps its phones off the internet. Phones, the app and the server only need
to reach each other.

## What works with no internet

Tested end to end on one network where the browsers could reach only the server:

- first-run setup from the server's setup link, passkeys (made and used to sign back in), recovery
  codes and invites;
- pairing a browser phone (`/device/`) through the app;
- calls both ways between the app and a phone, with audio going straight between them on your
  network;
- voicemail when nobody answers: the greeting, the message, and playing it back.

Neither the apps nor the server tried to reach anything else while doing it. The only outside
addresses in the apps are the help and project links (they don't open offline, nothing else
depends on them).

The hardware phone's firmware was tested against a server on the same machine in a simulator:
pairing, dialing an extension and playing a voicemail on the phone. It hasn't been tried on a real
board on an offline network yet.

## What doesn't

- **Anyone outside your network.** No connections to people on other servers or the public hub,
  no knocks, no calls from outside: federation needs the internet and a public name.
- **Transcripts**, unless you run a speech-to-text service on your network and point
  `TRANSCRIBE_URL` at it (any OpenAI-compatible `/v1/audio/transcriptions` endpoint; untested).
  Voicemail itself works without one.
- **Updates.** Phones can't check for new firmware; update them over USB when you have one.
- **The help links** in the app (they go to openloungephone.app).

## 1. Start the server

Run it as in [self-hosting](/how-to/self-host/), with no STUN server (there's no internet to ask)
and its HTTPS name as the public address:

```sh
STUN_URLS= PUBLIC_URL=https://phone.home.arpa npm start
```

`STUN_URLS=` (empty) turns STUN off; calls then use the devices' own network addresses, which is
all a single network needs. Leave TURN unset. Set `PUBLIC_URL` before anyone signs up: passkeys
belong to that name.

## 2. Give it a name

Browsers and passkeys need a name, not just an IP address. Pick one of these:

- **Your router's DNS:** most routers let you add a local name (often under *DHCP* or *Local
  DNS*). `phone.home.arpa` is a good choice: `home.arpa` is reserved for home networks. Give the
  server a fixed address (a DHCP reservation) while you're there.
- **mDNS (`.local`):** a Mac is already reachable as `its-name.local`, a Linux machine with Avahi
  too. Computers and most phones resolve these by themselves (untested on Android).

The hardware phone doesn't look up `.local` names, so give it the IP address or a router DNS name
(see step 5).

## 3. Turn on HTTPS

Browsers allow the microphone, calls and passkeys only on a secure address. On
`http://phone.home.arpa` or `http://192.168.1.10` the app opens, but calls fail with
*Microphone unavailable: the browser allows it only on an https:// address* and passkeys aren't
offered. (`localhost` counts as secure, which is why trying it on one computer works without
this step.)

The server speaks plain HTTP, so put a small HTTPS front in front of it with a certificate from
your own certificate authority (CA). Make the CA once, then a certificate for the name:

```sh
# Your home CA: install ca.pem on every computer and phone that uses the app.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -subj "/CN=Home phone CA" -keyout ca.key -out ca.pem

# The server's certificate.
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj "/CN=phone.home.arpa" -keyout server.key -out server.csr
printf "subjectAltName=DNS:phone.home.arpa\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n" > ext.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 397 \
  -extfile ext.cnf -out server.pem
cat server.pem ca.pem > chain.pem
```

Keep `ca.key` somewhere safe and offline: anyone with it can make certificates your devices
trust. Make a new `server.pem` before it runs out (Apple devices refuse server certificates valid
for more than 825 days).

Then any reverse proxy that does HTTPS and WebSockets will do. With
[Caddy](https://caddyserver.com/) (download it while you still have internet), a `Caddyfile`:

```
phone.home.arpa {
  tls chain.pem server.key
  reverse_proxy 127.0.0.1:8787
}
```

Caddy can also make the CA for you: `tls internal` instead of the `tls` line, then install its
root certificate (`caddy trust` prints where it is). We tested the certificates above behind a
small HTTPS proxy; the Caddy configuration itself is untested.

## 4. Trust your CA on each device

Install `ca.pem` once on every computer and phone that opens the app (all untested on real
devices; the steps are each system's own):

- **Mac:** open `ca.pem`, add it to the *System* keychain, open it in Keychain Access and set
  *Trust* to *Always Trust*.
- **Windows:** open `ca.pem` → *Install Certificate* → *Local Machine* → *Trusted Root
  Certification Authorities*.
- **Linux:** copy it to `/usr/local/share/ca-certificates/home-phone-ca.crt` and run
  `sudo update-ca-certificates`. Firefox has its own list: *Settings → Privacy & Security →
  Certificates → View Certificates → Authorities → Import*.
- **iPhone and iPad:** send it to the device (AirDrop, mail it before going offline, or open it
  from a web page on the server), install the profile in *Settings*, then turn it on under
  *General → About → Certificate Trust Settings*.
- **Android:** *Settings → Security → More security settings → Encryption & credentials →
  Install a certificate → CA certificate* (names differ between makers). Chrome trusts it.

Then open `https://phone.home.arpa/#setup=…` (the setup link the server printed, with your name)
and set up as usual.

Passkeys were tested with a browser's own passkey store. A phone's passkey manager (iCloud
Keychain, Google Password Manager) may want the internet to save or sync one: untested. Make sure
everyone keeps their **recovery code** either way (Account → Recovery code).

## 5. Point the hardware phone at it

On the phone's setup page (see [Set up a phone](/how-to/pair-a-phone/)), choose **My own server**
and type the server's own port, without HTTPS:

```
ws://192.168.1.10:8787
```

The phone trusts only the public certificate authorities built into it, not your home CA, so it
talks to the server directly on your network. Use the IP address (reserved in your router) or a
router DNS name, not a `.local` name. The phone still proves who it is with its own key, and call
audio is encrypted end to end; only its connection to the server isn't. Then pair it as usual.

A browser phone uses the HTTPS address like the app: `https://phone.home.arpa/device/`.

## Clocks

With no internet, nothing sets the time for you. Keep the server's clock right (hardware phones take
theirs from the server); a clock far off also makes certificates look not yet valid or expired.
