# Dash Proxy
node-dash-proxy is a tool that allows for downloading of remote MPEG-DASH streams. Based on the [Python script from Viblast](https://github.com/Viblast/dash-proxy/)

## How to use

### Install dependencies
```shell
npm install
```

### Mirroring a remote live stream
```shell
node ./dashproxy.js http://server.com/Manifest.mpd -o .
```
The content of `http://server.com/Manifest.mpd` will be downloaded to the output directory (specified by `-o`). The MPD will be constantly refreshed and when new content is available it will be also downloaded while old content will be removed. This will practically mirror the remote stream in the output directory (`-o`). The downloaded stream itself can be served using any HTTP server.

### Downloading a remote live stream
```shell
node ./dashproxy.js http://server.com/Manifest.mpd -o . -d
```
This will behave just as the above command except that old content will not be deleted effectively downloading the live stream in the output directory (`-o`). This is useful for downloading a long sample of a live stream that can latter be used for debugging and testing puposes.

### Downloaidng a remote VoD steram
```shell
node ./dashproxy.js http://server.com/Manifest.mpd -o . -d
```
The VoD stream will be downloaded in the output directory (`-o`). In this case the download (`-d`) parameter is effectively ignored. In this example it is provided for clarity.

## Supported features
 * Segment Timeline

## Compatibility
Tested on NodeJS v7.7.2 and NPM 4.1.2

## License
MIT
