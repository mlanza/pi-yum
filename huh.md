# Huh

`/huh` reads the latest completed assistant answer on the current session branch.
It works with `/speak off`, makes no model request, changes no settings, and adds
nothing to the screen. It uses privateer-speak's chosen provider, voice, pace,
reading-length limit, and Markdown cleanup.

If the answer cannot be read, it says only “huh”. If the chosen provider fails,
it tries the local OS voice. If no audio provider works, it stays silent rather
than printing an error.

`/huh stop` cancels synthesis and playback. `/speak stop`, `/speak off`, a new agent
run, branch navigation, and session shutdown also cancel replay.

## Loading

Depends on the **`privateer-speak`** npm package (validated with version 0.8.0),
installed globally through Pi. If it is missing, Pi shows an on-screen extension
load error naming the dependency and this install command:

```sh
pi install npm:privateer-speak
```

This project's `.pi/settings.json` loads `huh.js` and disables privateer-speak's
standalone entry point **only in this project**. Run `/reload`, then `/huh`.
All original `/speak`, `/talk`, and `/mood` commands remain available.
No installed package or personal settings were changed.

To enable it elsewhere, load `huh.js` in that project's or your personal Pi
settings and apply the same package filter. Do not load the original entry point
alongside it, or Pi will register duplicate speech commands and event handlers.

## Dependency seam

`huh.js` is a wrapper, not a speech engine or an upstream patch. It resolves the
existing package from Pi's managed global npm installation (respecting Pi's agent
directory) and calls its exported extension factory. Both replay and the original
extension use the same exported provider registry and playback helpers.

Pi loads sibling extensions with separate module caches. Importing the same package
from two independent extensions does not share those singletons. Loading the original
factory through this wrapper avoids that trap. No second dependency copy is installed.

Updates to privateer-speak cannot erase this extension. Breaking changes to its public
exports can still require an update here. The dependency must remain installed even
though its standalone extension entry is disabled. Replay does not join the original
speech queue or open a microphone.

## Validation

```sh
node --test tests/huh.test.js
```

Tests use fake providers and never play real audio. The manual check is `/reload`,
`/speak off`, then `/huh`: hear the last answer without new screen output.
