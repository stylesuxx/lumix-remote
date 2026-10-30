# Lumix Remote

Shoot a photo series from your desk: swap the subject in front of the camera,
then at the PC check the live view, set focus and exposure, take the picture,
and inspect it at 100% before moving on. Made for photographing miniatures,
where the camera sits on a stand and touching it would shift the framing.

Lumix Remote is a small Node.js server that talks to a Panasonic Lumix camera
over the camera's own WiFi network, and serves a web page with:

- live view (640x360 or 320x180, up to about 28 frames per second)
- click-to-focus on any point of the live view
- manual focus, in fine and fast steps (focus lever on MF)
- the camera's still-photo settings as dropdowns
- capture with automatic download of the full-size JPEG, and RAW files
  downloaded on request
- a viewer for the shot just taken, with a 100% zoom for checking focus
- a gallery of everything in the current save folder, in a bar on the
  bottom edge that slides up on hover, where shots can be deleted
- a folder browser for choosing where captures go

## Camera compatibility

Tested only with a **Panasonic Lumix DMC-G7 (G70)** on firmware 2.2. The
header shows the model and firmware of the camera that took the newest
JPEG in the save folder, read from its EXIF data.

### Likely to work

Lumix cameras that support remote shooting with Panasonic's **Image App**
over WiFi speak the same HTTP API (`cam.cgi`), so these are likely to work.
None of them has been tried:

| Series | Models |
| --- | --- |
| G | G80 / G85, G81, G9 |
| GH | GH4, GH5, GH5S |
| GX | GX7, GX8, GX80 / GX85, GX9 |
| GF | GF7, GF8, GF9 / GX800 / GX850, GF10 / GX880 |
| Compact | LX100, LX100 II, TZ100 / ZS100, TZ200 / ZS200, FZ1000, FZ2000 / FZ2500 |

Expect differences: the settings a camera lists, which of them it accepts
over WiFi, and which controls only a dial or lever on the body can change.
Newer models that pair only with the **Lumix Sync** app (for example the
GH6, G9 II and S5 II) use a different protocol and are unlikely to work.

### Report your camera

If you try Lumix Remote with another camera, please
[open an issue](https://github.com/stylesuxx/lumix-remote/issues) and say
whether it worked. Include:

- the model and firmware shown in the header
- what worked: live view, click to focus, manual focus, settings, capture,
  Download RAW
- what failed, with the error message from the page or the terminal

Run the server with `--verbose` when something fails; the extra output
helps.

## Requirements

- Node.js 24 or newer
- A PC with WiFi that can join the camera's network

The app uses only Node's built-in modules (`http`, `dgram`, `fetch`,
`node:test`), so there are no npm dependencies to install or keep up to
date.

## Setup

1. On the camera, open the WiFi menu and start a connection for a smartphone
   (Wi-Fi Function > New Connection > Remote Shooting & View). The camera
   creates its own access point and shows its network name.
2. Join that network from the PC. The camera is then reachable at
   `192.168.54.1`.
3. Start the server:

   ```sh
   npm start
   ```

4. Open <http://127.0.0.1:8080>.

### Options

```sh
node src/server/main.js --directory ~/Pictures/miniatures --port 8080
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--directory` | last folder used, else `~/Pictures/lumix` | Where captures are saved |
| `--camera` | `192.168.54.1` | Camera address |
| `--host` | `127.0.0.1` | Interface the web server listens on. Use `0.0.0.0` to reach it from a phone or tablet |
| `--port` | `8080` | Web server port |
| `--verbose` | off | Log live view renewal errors |

Choose the save folder in the page, either by typing a path or with
Browse, which walks the PC's folders and can create new ones. The choice is
remembered in `~/.config/lumix-remote/config.json` and used at the next
start.

## Using it

**Focus.** Click anywhere in the live view and the camera autofocuses on that
point. The camera refocuses on a remote touch only in its Touch AF mode, so a
click sets the AF mode to Touch AF first. The size of the AF area cannot be
changed over WiFi; set it on the camera (rear dial in 1-area mode). With the
focus lever on MF, the Near and Far buttons (or the Left and
Right arrow keys, with Shift for big steps) drive the focus motor, and the bar
between them shows the focus position. Turn on focus peaking in the settings
to see what is sharp.

**Capture.** Press Capture or Space. The live view pauses while the camera
shoots. The camera's 1920x1080 preview appears within a few seconds, and the
full-size JPEG replaces it once downloaded. Settings, focus and a second
capture are refused while the camera is shooting, and the page says so.

**RAW files.** A RAW file (about 19 MB) stays on the camera's card until you
ask for it, since downloading one takes most of the WiFi link and slows
everything else. Press Download RAW in the gallery bar to fetch the RAW of
every shot in the folder that has none yet, or Download RAW in the viewer
for the shot shown. Downloads run one after another; a chip in the header
counts them. Live view pauses while they run, which makes them several
times faster (about 15 s instead of 80 s per file on a G7); Show live view
on the paused view brings it back until the queue is empty. A capture
pauses the RAW download until its JPEG is saved, and the download then
continues where it stopped. A failed download shows a message and is
retried after 5 s, 15 s, 30 s, 1 min and 2 min, again from where it
stopped. A download fails only when no data arrives for 20 seconds, so a
slow link still completes. Downloads still queued when the server stops are
dropped; press Download RAW again after the next start.

The RAW badge on a thumbnail shows its state: dashed while the RAW is only
on the card, outlined while it downloads, solid once it is saved.

**Delete.** Hover a thumbnail and click its ×, or press Delete in the viewer,
to remove a shot's files from the folder. Its RAW is then left out of any
download. The camera's card keeps its copy.

**Check the shot.** Click the image to zoom to 100% around that point; click
again to fit. Left and Right step through older and newer captures. Esc or
Live view returns to the live view. Space takes the next picture straight
from the viewer.

**Files.** Each capture is saved under its card name, for example
`P1100136.JPG` and `P1100136.RW2`, depending on the quality setting. If that
name already exists in the folder (the card counter was reset), a timestamp
is prepended. A hidden `.previews` folder inside the save folder holds the
gallery previews and, per shot, a small file recording where its RAW is on
the card. Shots saved before that file existed offer no RAW download.

### Keyboard

| Key | Live view | Viewer |
| --- | --- | --- |
| Space | Capture | Close viewer and capture |
| Left / Right | Focus near / far (MF) | Older / newer capture |
| Shift + Left / Right | Focus near / far, big step | |
| Z | | Toggle 100% zoom |
| Delete | | Delete the shot shown |
| Esc | | Back to live view |

## Settings

The page reads all values from the camera when it opens, after every change
and capture, and when its window regains focus (to pick up changes made on
the camera body, such as the focus lever). Refresh reads them again. It lists
only the choices the camera currently allows. Some settings are rejected in some exposure modes;
for example the camera rejects exposure compensation in M.

### Adjustable from the app

| Setting | Values on the G7 |
| --- | --- |
| Shutter speed | 60 s to 1/4000 in 1/3 stops |
| Aperture | Lens range in 1/3 stops (read from the lens) |
| ISO | Auto, 80 to 25600 |
| Exposure compensation | -5 to +5 EV in 1/3 stops (P, A, S modes) |
| White balance | Auto, daylight, cloudy, shade, incandescent, flash, white set 1 to 4, color temperature. Measuring a white set needs the camera body: measure it there once, then choose it here |
| Metering | Multiple, center weighted, spot |
| AF mode | Face/eye detection, tracking, 49-area, custom multi, 1-area, touch AF, touch shutter |
| Quality | JPEG fine, JPEG standard, RAW + JPEG fine, RAW + JPEG standard, RAW only |
| Aspect ratio | 4:3, 3:2, 16:9, 1:1 |
| Focus peaking | Off, low, high |
| Photo style | Standard, vivid, natural, monochrome, scenery, portrait, custom |
| Flash (when up) | The mode the built-in flash uses once it is popped up; a closed flash never fires. In M mode the G7 offers only forced on, with or without red-eye reduction |
| Live view size | 640x360, or 320x180 for a weak WiFi link |
| Focus point | Click in the live view |
| Manual focus | Near / far, fine and fast steps (focus lever on MF) |

### Shown, set on the camera

| Setting | Why |
| --- | --- |
| Focus mode (AF-S, AF-C, MF) | The G7 sets it with the lever on the body |
| Drive mode (single, burst, self-timer) | The G7 sets it with the drive dial |
| Picture size | The camera reports it but rejects changes over WiFi |
| AF area size | No WiFi command; rear dial in 1-area mode |

Exposure mode (P, A, S, M) is on the mode dial and shutter type (mechanical or
electronic) is in the camera menu. For still subjects, the electronic shutter
avoids shutter shock blur.

## How it works

The camera exposes three services on its WiFi network:

- `http://192.168.54.1/cam.cgi`: commands and settings (`mode=camcmd`,
  `mode=setsetting`, `mode=getsetting`, `mode=camctrl`, `mode=getinfo`)
- UDP live view: after `mode=startstream&value=<port>`, the camera sends one
  JPEG frame per datagram to that port on the PC. The camera stops streaming
  after about 10 seconds without requests, so the server polls
  `mode=getstate` every 3 seconds. Repeating `startstream` while frames arrive
  disrupts the stream, so it is sent again only when frames stop.
- `http://192.168.54.1:60606/Server0/CDS_control`: a UPnP ContentDirectory
  listing the card. Each image has an original (`DO…JPG` / `DO…RW2`), a
  1920x1080 preview (`DL…JPG`) and a thumbnail (`DT…JPG`), served on port
  50001.

After the shutter fires, the camera answers `err_busy` to image count queries
until it is switched to playback mode. The app therefore switches to playback
mode, waits for the image count to rise, downloads the new files, and returns
to record mode for live view.

## Development

```sh
npm run check
```

Syntax-checks every source file and runs the tests with `node --test`. The
tests replace `fetch` with a fake camera and never need the real one. GitHub
Actions runs the same check on Node 24 and 26 for every push and pull request
(`.github/workflows/test.yml`).

## Troubleshooting

**"camera not reachable"**: the PC is not on the camera's WiFi network, or
the camera's WiFi connection screen was closed. Start the smartphone
connection on the camera again and rejoin its network.

**Live view stays black**: a firewall is dropping the UDP frames. Allow
incoming UDP on port 49199 from `192.168.54.1`.

**Live view stutters and commands are slow**: the live view uses most of the
camera's WiFi bandwidth, so on a weak link every command queues behind it
(ping to the camera rises from a few ms to over a second). Move the camera
and the PC's antenna closer together, and set Live view size to 320x180.
WiFi power saving on the PC adds latency too; on NetworkManager, disable it
for the camera's connection with
`nmcli connection modify <camera network> 802-11-wireless.powersave 2`.

**Near / Far buttons are disabled**: the focus lever is not on MF.

**A setting snaps back after changing it**: the camera rejected it in the
current mode. The error message shows the camera's answer.
