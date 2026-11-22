# Beta 35: smooth results and stable filter changes

New result cards fade in over 240 ms with a 6 px upward motion and a capped 24 ms stagger. Unchanged results retain their DOM nodes, expanded notes and position when switching filters. The list no longer dims and restarts a container animation for every query. Background synchronization remains unanimated, and reduced-motion preferences use the existing immediate-result path.

Loading an existing view no longer inserts and removes a loading sentinel. Responses also need to match the current filter snapshot before committing, including the interval before the input debounce starts the next request.

Verified on November 22, 2026:

- All 26 Node regression tests passed.
- Browser checks used isolated local data. Searching rub, switching All to Word, expanding the note and switching back preserved the card and expanded content. The card's top position (235.59375 px), height (103.390625 px when collapsed) and viewport width were identical across the filter switch.
- Searching turn introduced two new results. Switching All to Expression retained both existing card nodes and their positions, without an entry animation or reload flash.
- The self-contained package lifecycle validates installation, upgrade, rollback, native resources and exports using a temporary profile.

The local preview screenshot and detailed package logs are retained in the staging directory. Existing host-managed plugin processes require reconnection or restart to load a new packaged UI.
