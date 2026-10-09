const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;
const fs = require('node:fs/promises');
(async()=>{const sizes=[16,32,48,64,128,256];const buffers=await Promise.all(sizes.map(size=>sharp('assets/icon.svg').resize(size,size).png().toBuffer()));await fs.writeFile('assets/icon.png',buffers.at(-1));await fs.writeFile('assets/icon.ico',await pngToIco(buffers));})();
