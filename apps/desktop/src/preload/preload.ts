import { contextBridge, ipcRenderer } from "electron";
import { createApi } from "./api";

contextBridge.exposeInMainWorld("memelens", createApi((channel, payload) => ipcRenderer.invoke(channel, payload)));
