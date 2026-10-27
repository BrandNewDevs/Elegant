# dmgbuild settings for the installer window; scripts/dmg.sh passes the app path and the background as -D defines.
# The window and the slot centres must match scripts/dmg-background.swift, which draws the arrow between them.
import os

app = defines["app"]  # noqa: F821 (dmgbuild provides `defines`)

format = "UDZO"
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}
background = defines["background"]  # noqa: F821

window_rect = ((200, 120), (660, 400))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
arrange_by = None
icon_size = 128
text_size = 13
icon_locations = {
    os.path.basename(app): (180, 190),
    "Applications": (480, 190),
}
