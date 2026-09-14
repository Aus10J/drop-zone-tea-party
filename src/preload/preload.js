'use strict';

/**
 * The only bridge between the renderer and Node. The renderer gets a fixed
 * list of named calls and nothing else — no fs, no require, no ipcRenderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (payload) => ipcRenderer.invoke(channel, payload || {});

contextBridge.exposeInMainWorld('api', {
  bootstrap: call('app:bootstrap'),

  scan: {
    resolve: call('scan:resolve'),
    preview: call('scan:preview'),
  },

  layout: {
    get: call('layout:get'),
    save: call('layout:save'),
    preview: call('layout:preview'),
  },

  patron: {
    status: call('patron:status'),
    update: call('patron:update'),
    ban: call('patron:ban'),
    list: call('patron:list'),
    history: call('patron:history'),
    find: call('patron:find'),
    create: call('patron:create'),
    footprint: call('patron:footprint'),
    delete: call('patron:delete'),
  },

  product: {
    list: call('product:list'),
    save: call('product:save'),
    archive: call('product:archive'),
    setPrice: call('product:setPrice'),
    bulkPrice: call('product:bulkPrice'),
  },

  inventory: {
    adjust: call('inventory:adjust'),
    meta: call('inventory:meta'),
    adjustments: call('inventory:adjustments'),
    lowStock: call('inventory:lowStock'),
  },

  ticket: {
    price: call('ticket:price'),
  },

  order: {
    create: call('order:create'),
    void: call('order:void'),
    removeItem: call('order:removeItem'),
    recent: call('order:recent'),
  },

  shift: {
    current: call('shift:current'),
    open: call('shift:open'),
    close: call('shift:close'),
  },

  report: {
    day: call('report:day'),
    range: call('report:range'),
    sales: call('report:sales'),
    pdf: call('report:pdf'),
    table: call('report:table'),
    names: call('report:names'),
  },

  settings: {
    all: call('settings:all'),
    save: call('settings:save'),
    setPin: call('settings:setPin'),
    verifyPin: call('settings:verifyPin'),
    purgePii: call('settings:purgePii'),
  },

  backup: {
    status: call('backup:status'),
    now: call('backup:now'),
    list: call('backup:list'),
    chooseDir: call('backup:chooseDir'),
    openDir: call('backup:openDir'),
  },

  exporter: {
    bundle: call('export:bundle'),
    csv: call('export:csv'),
    backupDb: call('export:backupDb'),
    revealData: call('export:revealData'),
    openPath: call('export:openPath'),
  },

  onNav: (cb) => {
    const listener = (_e, view) => cb(view);
    ipcRenderer.on('nav', listener);
    return () => ipcRenderer.removeListener('nav', listener);
  },

  /** Fires when the business day rolls over and every drink count resets. */
  onBusinessDate: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('business-date', listener);
    return () => ipcRenderer.removeListener('business-date', listener);
  },
});
