"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("threadlightDesktop", Object.freeze({
  saveReport(payload) {
    return ipcRenderer.invoke("threadlight:save-report", payload);
  },
}));
