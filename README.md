# Christmas Larder

A shared list of the Christmas food in the garage freezers and boxes. Scan a barcode with your phone to add or take out an item. New products get their name automatically from [Open Food Facts](https://world.openfoodfacts.org/).

The app lives at **https://localpulse26-debug.github.io/Christmas-Larder-/**

The list is saved in your own Google Sheet, so everyone in the house sees the same thing, and you can open the sheet to check or fix anything.

## Set up

You only do this once. It takes about 10 minutes.

### 1. Turn on the website

1. On this GitHub page, open **Settings** (top of the page).
2. Scroll to the bottom, to **Danger Zone**, choose **Change visibility**, then **Make public**. Only the app's code becomes public. Your list stays private in your Google Sheet.
3. In the left menu choose **Pages**. Under **Branch**, pick **main** and **/ (root)**, then **Save**.
4. After a minute or two the app opens at the address above.

### 2. Make the Google Sheet

1. Go to [sheets.new](https://sheets.new) to create a new Google Sheet. Name it "Christmas Larder".
2. In the sheet's menu choose **Extensions → Apps Script**.
3. Delete everything in the code box. Open [Code.gs](google-sheet/Code.gs), press the copy button (two squares, top right of the file), and paste it into the code box.
4. Press the **Save** icon (the floppy disk).
5. Press **Deploy → New deployment**. Click the gear next to "Select type" and choose **Web app**.
6. Set **Execute as: Me** and **Who has access: Anyone**. Press **Deploy**.
7. Google asks you to authorise it. Choose your account. If you see "Google hasn't verified this app", press **Advanced**, then **Go to … (unsafe)**, then **Allow**. It's your own script, so this is expected.
8. Copy the **Web app URL**. It starts with `https://script.google.com/macros/s/` and ends with `/exec`.

### 3. Connect the app

1. Open the app on your phone.
2. Paste the Web app URL into **Sheet link** and press **Save and test**. You should see your four places: Freezer 1, Freezer 2, Sweets box and Pickles box.
3. Press **Share setup link** and send it to the family. Opening that link sets up their phone in one tap. Keep it within the household, because anyone with it can change the list.

Tip: in your phone browser's menu choose **Add to Home Screen** so the larder opens like an app.

## Using it

- **Scan** opens the camera. Hold the barcode inside the white box.
  - New product: the name fills in from Open Food Facts. Pick the freezer or box and how many, then **Add to larder**.
  - Already in the larder: tap − when you take one out, + when you put one back.
  - If the camera won't read it, use **Use a photo** or **Type numbers**.
- **+ Add item** is for homemade or unlabelled food.
- **Edit places** renames, adds or deletes freezers and boxes.
- **Use soon** appears when something is within two weeks of its use-by date.

## If you change the sheet script later

In Apps Script use **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. That keeps the same link, so nobody needs to set up again.

## What's in here

- `index.html`, `app.js`: the app.
- `google-sheet/Code.gs`: the script that connects the app to the Google Sheet.
- `vendor/`: the barcode reader ([ZXing](https://github.com/zxing-js/library), Apache 2.0 licence), used on phones whose browser can't read barcodes by itself.
