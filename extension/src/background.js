// Service worker: the toolbar button opens the side panel; the context menu sends
// the selection or the page to it as a draft goal (the user still presses Start).
import { draftFrom } from "./api.js";

const MENU_SELECTION = "architect-selection";
const MENU_PAGE = "architect-page";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_SELECTION, title: "Send selection to :\\ARCHITECT\\", contexts: ["selection"] });
    chrome.contextMenus.create({ id: MENU_PAGE, title: "Send this page to :\\ARCHITECT\\", contexts: ["page"] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_SELECTION && info.menuItemId !== MENU_PAGE) return;
  const draft = draftFrom({
    selection: info.menuItemId === MENU_SELECTION ? info.selectionText : "",
    pageUrl: info.pageUrl || tab?.url || "",
    pageTitle: tab?.title || "",
  });
  // open() must run inside the click's user gesture, before any await.
  if (tab?.windowId !== undefined) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  chrome.storage.session.set({ draft: { ...draft, at: Date.now() } });
});
