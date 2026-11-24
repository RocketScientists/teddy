# Teddy

Teddy sorts browser tabs into tab groups and keeps tab groups in bookmarks so they can be reopened later.

## Language

### Tab groups and bookmarks

**Tab group**:
A named, coloured set of tabs in one browser window.
_Avoid_: Group (when a bookmark folder could be meant), category

**Group name**:
The title of a tab group. It may contain the group separator, which divides it into a group path.
_Avoid_: Label, category

**Group separator**:
The text that divides a group name into the parts of its group path. It is set by the user and defaults to "/".
_Avoid_: Delimiter

**Group path**:
The list of folder names, below the root folder, that a group name maps to. "Project/ABC" maps to `Project` › `ABC`.
_Avoid_: Hierarchy, folder path

**Root folder**:
The bookmark folder that holds every saved group. By default it is a folder named "Teddy" under "Other bookmarks".
_Avoid_: Base folder, Teddy folder

**Saved group**:
A bookmark folder at a group path under the root folder. Its direct bookmarks are the tabs of the tab group, in order. Its subfolders are other saved groups.
_Avoid_: Snapshot, backup, stash

**Save**:
To make a saved group match a tab group's current tabs, replacing the folder's direct bookmarks. The tabs stay open.
_Avoid_: Export, backup, sync

**Restore**:
To open a saved group's direct bookmarks as tabs in a tab group whose name is the group path joined with the group separator.
_Avoid_: Import, reopen, load
