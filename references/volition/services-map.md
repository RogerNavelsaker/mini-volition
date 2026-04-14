##### Home

{{ DELETE THIS MESSAGE: I have heavily redacted this file to remove sensitive information about my home network and services. This is a template/example file for others to use as reference when documenting their own home lab/services for the Abiverse. Thank you! -Abe }}

{{ This is a template file. You should delete the contents of this file and populate this with your own home lab/services information. Make sure this is extensive as this will be the single source of truth for your services and home lab for the Abiverse. -Abe }}


-------------

Most of the hostnames are done in style of Iain M Banks' Culture. Not 1:1 from the books, and not too on the nose but a subtle nod at what a service/container/VM does.
MAIN_SERVER, VPS_2, VPS_1, VPS_4, VPS_3 [redacted] are legacy names. They were some of my very first servers. -Abe

Almost every single node/server/device is connected via wireguard, most are connected through headscale.

Router: 10.x.x.1 - user: root, pw: [REDACTED] . Abes: You can ssh to it if needed, but please notify me in case you want to change something and wait for my response. Default password for most of my services is [REDACTED].


| Hostname                    | Hardware                 | CPU                           | RAM  | OS                        | IPs                                                                         |
| --------------------------- | ------------------------ | ----------------------------- | ---- | ------------------------- | --------------------------------------------------------------------------- |
| MAIN_SERVER                  | HP Pro Desk G3 400       | i3-6100                       | 16GB | Ubuntu Server 24.04.2 LTS | 10.0.0.XX (static), 10.1.1.XX (WG), MAIN_SERVER (Headscale)                  |
| gsv-contents-under-pressure | Dell Optiplex 3050 Micro | i3-7100T                      | 16GB | Proxmox 8                 | 10.0.0.XX (static), 10.1.1.XX (WG), gsv-contents-under-pressure (headscale) |
| gsv-careful-orchestration   | Dell Optiplex 3050 Micro | i5-7500T                      | 24GB | Proxmox 8                 | 10.0.0.XX (static), 10.1.1.XX (WG), gsv-careful-orchestration (headscale)   |
| slv-wdym-buffering          | HP ProDesk 600 G3 Mini   | i5-7500T                      | 24GB | Ubuntu Server 24.04.2 LTS | 10.0.0.XX (static), 10.1.1.XX, slv-wdym-buffering (headscale)               |
| VPS_3                     | Oracle VPS               | x86/64                        | 1G   | Ubuntu Server 22.04 LTS   | [PUBLIC_IP] (static) 10.1.1.XX (WG) VPS_3 (headscale)                  |
| VPS_2                     | Oracle VPS               | 3Core Ampere A1               | 16G  | Ubuntu Server 24.04 LTS   | [PUBLIC_IP] (static) 10.1.1.XX (WG), VPS_2 (headscale)                   |
| VPS_1                      | Oracle VPS               | 1Core Ampere A1               | 8G   | Ubuntu Server 24.04 LTS   | [PUBLIC_IP] (static), 10.1.1.XX (WG), VPS_1 (headscale)                 |
| lcu-a-matter-of-protocol    | SoftShellWeb VPS         | 1 core 3.0GHz(Xeon Gold)      | 1G   | Ubuntu server             | [PUBLIC_IP] (static), 10.1.1.XX ( WG)                                       |
| VPS_4                      | Google VPS               | 1 vCPU (Intel Xeon @ 2.20GHz) | 1G   | Ubuntu Server 24.04 LTS   | [PUBLIC_IP] (static), 10.1.1.XX (WG)                                         |
|                             |                          |                               |      |                           |                                                                             |

Virtual Machines/LXC Containers inside `GSV-Careful-Orchestration`:

| Type    | Hostname                                       | IPs                                                        | Purpose/Service                                                                                     |
| ------- | ---------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| lxc     | 101 (subtle-device-manager)                    | 10.0.0.XX                                                  | zigbee2mqtt, alpine                                                                                 |
| lxc     | 102 (fxa)                                      | 10.0.0.XX , 10.1.1.XX, 172.17.0.1, 172.18.0.1, 172.19.0.1 | Firefox Identity and Storage/Sync Server                                                            |
| lxc     | 103 (rou-cartographers-dilemma)                |                                                            | Currently Disabled/stopped, Past:GMaps Timelines alternative                                        |
| lxc     | 104 (its-probably-u-but-lets-check)            | 10.0.0.XX, 10.1.1.XX                                     | PocketID OAuth instance                                                                             |
| lxc     | 105 (scu-i-know-a-guy)                         | 10.0.0.XX                                                   | Adblock Instance                                              |
| lxc     | 106 (scu-the-courtesy-of-a-reply)              | 10.0.0.XX                                                   | Currently Inactive PXEboot instance                                                                 |
| lxc     | 107 (volition-stream)                          | 10.0.0.XX, 10.1.1.XX                                     | Redis for Abes                                                                                      |
| lxc     | 201 (remote-courtesy)                          | 10.0.0.XX, 10.1.1.XX                                      | Guacamole Instance, currently running RDP                                            |
|         |                                                |                                                            |                                                                                                     |
| qemu    | 100 (rou-ofc-i-know-where-ur-keys-are)         | 10.0.0.XX, 172.30.232.1, 172.30.32.1                       | Homeassistant                                                                                       |
| qemu    | 501 (its-not-a-bug-01)                         | 10.0.0.XX, 10.1.1.XX, 100.64.0.12                         | Tinkering/Homelab VM 1                                                                              |
| qemu    | 502 (its-not-a-bug-21)                         | 10.9.9.XX                                                   | Tinkering/Homelab VM 1                                                                              |
| qemu    | 503 (its-not-a-bug-22)                         | 10.9.9.XX                                                   | Tinkering/Homelab VM 1                                                                              |
| qemu    | 699 (VM 699)                                   |                                                            | PXEboot testing VM                                                                                  |
| qemu    | 802 (OU-probably-still-mounted)                |                                                            | Windows VM if needed, Inactive                                                                      |
| sdn     | localnetwork (gsv-careful-orchestration)       |                                                            |                                                                                                     |
| storage | archive_MAIN_SERVER (gsv-careful-orchestration) |                                                            | MAIN_SERVER's `[PATH]/Archive` mounted at `/[PATH]/Archive/Proxmox` |
| storage | local (gsv-careful-orchestration)              |                                                            |                                                                                                     |
| storage | local-lvm (gsv-careful-orchestration)          |                                                            |                                                                                                     |

###### Virtual Machines/LXC Containers inside `GSV-Contents-Under-Pressure`:

Currently none. Abes will be hosted here, populate this list as abes come online.


###### Containers/Services Inside SLV-wdym-buffering
ZFS Pool running (XTBx5, mirror) at `/mnt/storage_media

```
user@slv-wdym-buffering ~> sudo zpool status media-pool
  pool: media-pool
  state: ONLINE
config:
    NAME                              STATE           READ WRITE CKSUM
    media-pool                        ONLINE             0     0     0
	  mirror-0                        ONLINE             0     0     0
	    ata-XXXXXXXXXXXXXXXXXXXXXXXXXX  ONLINE             0     0     0
        ata-XXXXXXXXXXXXXXXXXXXXXXXXXX  ONLINE             0     0     0
	  mirror-1                              ONLINE       0     0     0
		ata-XXXXXXXXXXXXXXXXXXXXXXXXXX  ONLINE       0     0     0
		ata-XXXXXXXXXXXXXXXXXXXXXXXXXX  ONLINE       0     0     0
```

Docker containers at `~/home/[user]/.config/`
- Media Server: docker containers of Jellyfin, Jellyseerr, Radarr, Sonarr, Prowlarr, Bazarr, Sabnzbd, qBitTorrent, qBitTorrent-vpn, jellystat
- Audiobookshelf
- Gluetun running to provide vpn access to qBT-vpn.
- Scrutiny server running, collects all homelab HDD info

###### Containers/Services Inside MAIN_SERVER:
Docker containers at `~/home/[user]/.config/`
- AdguardHome : Adguard
- sample-home : Hugo personal blog
- Calibre-Web-Automated
- Calibre-web-automated ebook Downloader
- Paperless-ngx
- Stirling-PDF
- Gluetun
- Immich: Google Photos alternative
- LibreChat : LLM Chat UI
- NextCloud
- Geoguesser clone
- Changedetection.io

Note: There are a LOT of unused, stopped containers in MAIN_SERVER that I someday need to delete. A lot of them are running on other hosts or have been deprecated since.

Services Running not On Docker:
- Syncthing
- Webmin
- Syncthing

Storage Attached on MAIN_SERVER: `/home/[user]/{PATH1, PATH2, PATH3}` 

###### Containers/Services Inside VPS_1:
Docker containers at `~/home/[user]/.config/`
- searXng
- Chevereto - Image hosting and sharing
Services Running not On Docker:
- Nginx and Certs: Nginx on VPS_1 manages [domains]
- Headscale : Tailscale Alteranative
- Headplane : UI for Headscale
- Webmin
- IRC bot at x on y network: Running inside screen
- wg-easy-docker-compose : WG-easy, wireguard.
- Syncthing.

###### Containers/Services Inside VPS_2:
Docker containers at `~/home/[user]/.config/`
- ProjectSend, secure file sharing
- Kutt, Link shortener
- Cyberchef
- Matrix (Pending migration to GSV-CO): Running with Ansible.
- Nextcloud
- Sharkey: ActivityPub/Mastodon alternative
- Vault: Vaultwarden/Bitwarden alternative.
- Pastebin 
- bot-chroma: Chromadb host for  bot

###### Containers/Services Inside VPS_3:
Docker containers at `~/home/[user]/.config/`
- ntfy
- anki
Services Running not On Docker:
- weechat: Running inside screen.
- Syncthing
