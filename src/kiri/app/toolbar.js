/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { menubar } from './menubar.js';

const toolbar = {
    build(actions) {
        menubar.build(actions);
    }
};

export { toolbar };
