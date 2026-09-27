# POC: עיבוד Sentinel-2 של Copernicus Data Space באמצעות DuckDB

## 1. מטרת הפרויקט

לבנות Proof of Concept שמדגים שאפשר להשתמש ב־DuckDB כמנוע SQL/Analytics
לעיבוד נתוני Sentinel-2 של Copernicus Data Space, בלי להוריד מראש את כל
תמונות הלוויין ובלי להסתמך על Google Earth Engine.

המטרה הסופית היא לבחון שימוש בנתוני Sentinel-2 לזיהוי מצב ושלבי ביצוע של
כבישים רחבים:

``` text
NATURAL
    ↓
EARTHWORK
    ↓
FORMATION / SUBBASE
    ↓
PAVED
    ↓
OPERATIONAL
```

ה־POC הראשון לא צריך לפתור את סיווג שלבי הכביש. הוא צריך להוכיח את שרשרת
הנתונים והעיבוד:

``` text
Copernicus Data Space
        ↓
       STAC
        ↓
בחירת Sentinel-2 scenes
        ↓
       S3
        ↓
      DuckDB
        ↓
 Sentinel-2 raster
        ↓
NDVI / BSI / band ratios
        ↓
Temporal features
        ↓
     Parquet
        ↓
      QGIS
```

------------------------------------------------------------------------

## 2. עקרונות התכנון

### 2.1 לא להוריד את כל ישראל

אין צורך להוריד מראש את כל נתוני Sentinel-2 של ישראל.

המערכת צריכה לעבוד באופן ממוקד:

1.  מגדירים AOI קטן סביב כביש/פרויקט.
2.  מחפשים ב־STAC רק scenes שחופפים ל־AOI.
3.  מסננים לפי תאריך ועננות.
4.  מוצאים את ה־assets הדרושים בלבד.
5.  קוראים את הרסטרים ישירות ככל שניתן.
6.  מחשבים רק את המדדים הדרושים.
7.  שומרים מקומית את התוצאה האנליטית, לא בהכרח את תמונת הלוויין.

### 2.2 הפרדה בין Discovery לבין Processing

STAC משמש ל־discovery:

``` text
איזה scene?
איזה tile?
איזה תאריך?
מה אחוז העננות?
איפה נמצא B04?
איפה נמצא B08?
איפה נמצא B11?
איפה נמצא B12?
```

DuckDB משמש ל־processing:

``` text
קריאת raster
חישובי bands
חישובי indices
חישובי temporal differences
צבירת סטטיסטיקות
שמירת תוצרים
```

------------------------------------------------------------------------

## 3. רכיבי המערכת

### Copernicus Data Space

המקור לנתוני Sentinel-2.

צריך להשתמש ב־STAC העדכני של Copernicus Data Space ולא בממשקי OpenSearch
הישנים.

STAC משמש לקבלת metadata ו־asset URLs.

### S3 של Copernicus Data Space

ה־Sentinel-2 assets זמינים דרך תשתית S3-compatible של CDSE.

הגישה דורשת credentials:

-   Access Key
-   Secret Key

אין צורך לבנות OAuth flow עבור גישת S3.

### DuckDB

DuckDB הוא מנוע העיבוד המרכזי.

רכיבים רלוונטיים:

-   `httpfs` --- גישה ל־S3/HTTP.
-   `spatial` --- עבודה גאוגרפית.
-   `DuckDB-WASM` --- SQL מקומי, metadata ו־Parquet בדפדפן.

`raster` ו־`stac` אינם תלות בסיס של ה־POC. הם extensions קהילתיים שיש
להפעיל רק אחרי שמוודאים שיש להם build תואם לגרסת DuckDB ולפלטפורמה.
בפרט, בדיקות שבוצעו עם DuckDB `1.4.1` ו־DuckDB-WASM לא מצאו מסלול טעינה
עובד ל־`raster`.

### קריאת COG בדפדפן

לקריאת pixels ב־client-only app נשתמש ב־`geotiff.js`, אשר קורא Cloud
Optimized GeoTIFF באמצעות HTTP range requests. החישובים על arrays קטנים
של AOI מבוצעים ב־TypeScript; DuckDB-WASM שומר ומנתח את ה־metadata ואת
טבלת התוצאות.

### QGIS

QGIS משמש בעיקר:

-   להצגת AOI.
-   להצגת תוצאות.
-   לבדיקה ויזואלית של scenes.
-   להשוואה בין תאריכים.
-   לעריכה/בדיקה של נתוני הכבישים.

------------------------------------------------------------------------

## 4. שלב ראשון --- הגדרת סביבת DuckDB

עדיף לא להתקין DuckDB באופן גלובלי אם קיימות כמה גרסאות.

מומלץ להחזיק גרסאות בצורה מפורשת, למשל:

``` text
C:\Tools\DuckDB\
    1.4.x\
        duckdb.exe
    1.5.x\
        duckdb.exe
```

ולבחור גרסה באמצעות PowerShell או wrapper.

בדיקות בסיס:

``` powershell
duckdb --version
Get-Command duckdb
where.exe duckdb
```

אפשר גם לבדוק את כל העותקים שנמצאים ב־PATH:

``` powershell
$env:PATH -split ';' |
    ForEach-Object {
        $p = Join-Path $_ 'duckdb.exe'
        if (Test-Path $p) { $p }
    }
```

------------------------------------------------------------------------

## 5. שלב שני --- credentials ל־CDSE

ל־POC אפשר להתחיל עם credentials זמניים בסביבת PowerShell:

``` powershell
$env:AWS_ACCESS_KEY_ID="..."
$env:AWS_SECRET_ACCESS_KEY="..."
```

לא לשמור credentials בתוך:

-   SQL שנשמר ב־Git
-   `.duckdbrc`
-   קוד Python
-   קובץ Markdown
-   repository

אפשר להשתמש גם ב־DuckDB Secret Manager, אבל צריך להבחין בין secret זמני
לבין persistent secret.

ב־POC ראשוני עדיף להימנע מהוספת מורכבות מיותרת ולבדוק תחילה גישה באמצעות
environment variables.

------------------------------------------------------------------------

## 6. שלב שלישי --- STAC Search

צריך למצוא Sentinel-2 L2A המתאים ל־AOI.

הפרמטרים העיקריים:

``` text
collection
bbox / geometry
datetime
cloud cover
```

לדוגמה, ברמת הקונספט:

``` sql
SELECT ...
FROM STAC_Search(
    'https://stac.dataspace.copernicus.eu/v1/search',
    collections := ['sentinel-2-l2a'],
    bbox := [35.15, 31.70, 35.25, 31.80],
    datetime := '2025-01-01/2025-12-31'
);
```

יש לבדוק בפועל את שם ה־collection, שמות ה־assets ומבנה התוצאה מול ה־STAC
העדכני לפני שהופכים את הקוד לסקריפט production.

------------------------------------------------------------------------

## 7. בחירת assets

לזיהוי כבישים ושלבי ביצוע אין צורך בכל ה־bands.

ה־POC צריך להתחיל עם:

  Band     Resolution שימוש
  ------ ------------ -------
  B04            10 m Red
  B08            10 m NIR
  B11            20 m SWIR
  B12            20 m SWIR

בנוסף רצוי להשתמש ב־SCL לצורך masking של:

-   cloud shadow
-   clouds
-   cirrus
-   pixels לא תקינים

### הערה חשובה

B04/B08 הם 10m, ואילו B11/B12 הם 20m.

אין להניח שהם נמצאים באותה רזולוציה בלי לבצע resampling או לבחור
workflow שמטפל בכך במפורש.

ל־POC אפשר להתחיל בחישובי B04/B08 בלבד, ולאחר מכן להוסיף B11/B12.

------------------------------------------------------------------------

## 8. השלב הקריטי: קריאת raster בלי DuckDB Raster

ה־assets המקוריים של CDSE הם JP2. אין להניח שהם COG, ואין לבנות את
ה־client-only workflow על extension `raster` שלא נטען בפועל.

ה־workflow הראשי משתמש ב־Sentinel-2 L2A COGs ציבוריים של Earth Search:

``` text
Earth Search STAC
  ↓
B04/B08/B11/B12/SCL COG URLs
  ↓
geotiff.js + HTTP range requests
  ↓
typed arrays עבור AOI קטן
```

בבדיקת ההיתכנות התקבלו עבור COG של B04:

``` text
Accept-Ranges: bytes
HTTP range response: 206
Access-Control-Allow-Origin: *
```

לכן דפדפן יכול לקרוא רק את ה־tiles/overview והחלון הדרושים ל־AOI, ולא את
כל מוצר ה־SAFE.

### CDSE נשאר מקור discovery ואימות

אפשר להמשיך לבצע STAC search מול CDSE ולהשתמש ב־S3 credentials לבדיקת
הגישה ל־assets המקוריים. עם זאת, קריאת JP2 של CDSE אינה חלק מה־baseline
של אפליקציית הדפדפן. התאמה בין scene של CDSE ל־COG תיעשה לפי תאריך, tile
ו־Sentinel product identifier.

### Raster extension כאופציה משנית

אם בעתיד יידרש workflow desktop מבוסס CDSE JP2, אפשר לבנות את
`duckdb-raster` מהמקור או להשתמש ב־build קהילתי תואם ומאומת. אין להניח
שהוא זמין ב־DuckDB-WASM או בכל גרסת DuckDB desktop.

------------------------------------------------------------------------

## 9. ניסוי מינימלי

לפני כל פיתוח נוסף צריך להצליח עם asset אחד בלבד.

### Test A --- STAC

להחזיר:

``` text
item_id
datetime
cloud cover
asset key
asset href
```

ולוודא שמתקבלים:

``` text
B04
B08
```

### Test B --- COG discovery

לקבל מ־Earth Search STAC את ה־assets `red`, `nir`, `swir16`, `swir22`
ו־`scl`, ולוודא שכל אחד הוא HTTPS COG.

### Test C --- COG metadata

להוציא:

``` text
width
height
resolution
CRS
extent
band
nodata
```

באמצעות `geotiff.js`, בלי להוריד את כל ה־COG.

### Test D --- pixels

להמיר את AOI ל־CRS של ה־tile ולקרוא חלון קטן בלבד באמצעות
`image.readRasters({ window })`.

אין לטעון tile שלם אם אין צורך.

### Test E --- NDVI

לחשב:

``` text
NDVI = (B08 - B04) / (B08 + B04)
```

### Test F --- AOI statistics

לחשב רק עבור AOI קטן סביב כביש.

לשמור mean, median, valid fraction ו־NDVI ב־Parquet באמצעות DuckDB-WASM.

רק לאחר שכל ששת המבחנים מצליחים כדאי לעבור ל־time series.

------------------------------------------------------------------------

## 10. Cloud masking

יש שני סוגי filtering.

### Scene-level

ב־STAC:

``` text
cloud cover < threshold
```

למשל:

``` text
< 20%
```

אבל זה רק filtering ראשוני.

### Pixel-level

צריך להשתמש ב־SCL כדי להסיר pixels שאינם מתאימים לניתוח.

זה חשוב במיוחד מכיוון ש־cloud cover של scene כולו לא אומר מה איכות
התמונה בדיוק מעל הכביש.

### Road/AOI-level quality

רצוי לחשב:

``` text
valid_pixels / AOI_pixels
```

ולהחזיק אותו כ־quality metric.

לדוגמה:

``` text
valid_fraction >= 0.90
```

יכול להיות תנאי מינימלי לניתוח, אבל את הסף יש לכייל על הנתונים בפועל.

------------------------------------------------------------------------

## 11. Feature engineering

לכל תאריך ולכל AOI נרצה לשמור features.

### Bands

``` text
B04
B08
B11
B12
```

### Indices

#### NDVI

``` text
(B08 - B04) / (B08 + B04)
```

#### BSI

אפשר להשתמש ב־Bare Soil Index בנוסחה המקובלת:

``` text
((B11 + B04) - (B08 + B02))
/
((B11 + B04) + (B08 + B02))
```

אם משתמשים ב־BSI צריך להוסיף גם B02.

### Ratios

כדאי לבדוק:

``` text
B08 / B04
B11 / B12
B11 / B08
B04 / B02
```

אין צורך להחליט מראש אילו features יהיו הטובים ביותר.

------------------------------------------------------------------------

## 12. המטרה המדעית --- לא סיווג חד-תאריכי בלבד

ההנחה המרכזית היא שלא כדאי לנסות לזהות:

``` text
"כביש"
```

מתמונה בודדת בלבד.

במקום זאת יש לזהות שינוי לאורך זמן:

``` text
vegetated / natural
        ↓
soil disturbance
        ↓
earthwork
        ↓
formation
        ↓
paving
        ↓
road in operation
```

לכן לכל feature כדאי לשמור גם temporal derivatives.

לדוגמה:

``` text
ΔNDVI
ΔBSI
ΔB11
ΔB12
Δ(B11/B12)
```

וכן rolling statistics:

``` text
mean
median
min
max
standard deviation
```

בחלונות זמן.

------------------------------------------------------------------------

## 13. סכמת תוצאה מומלצת

במקום לשמור raster מלא לכל שלב, ה־POC יכול להפיק טבלה:

``` text
project_id
aoi_id
scene_id
date
cloud_cover
valid_fraction

B04_mean
B04_median
B08_mean
B08_median
B11_mean
B11_median
B12_mean
B12_median

NDVI_mean
NDVI_median
BSI_mean
BSI_median

delta_NDVI
delta_BSI
delta_B11
delta_B12
```

ולשמור אותה כ־Parquet.

------------------------------------------------------------------------

## 14. למה Parquet

Parquet מתאים לתוצר האנליטי משום שהוא:

-   קומפקטי.
-   columnar.
-   ניתן לקריאה ישירה ב־DuckDB.
-   מתאים ל־time series.
-   ניתן לסינון לפי project/date.
-   קל להעביר ל־QGIS ולכלים אחרים.

כך לא צריך לשמור את כל imagery המקומי.

ה־raw data נשאר ב־CDSE.

התוצר המקומי הוא:

``` text
raw imagery → derived features
```

ולא:

``` text
raw imagery → copy entire archive locally
```

------------------------------------------------------------------------

## 15. שילוב QGIS

QGIS ישמש לבקרת איכות ולוויזואליזציה.

Workflow:

``` text
QGIS
  ↓
בחירת פרויקט / כביש
  ↓
יצירת AOI
  ↓
STAC search
  ↓
DuckDB processing
  ↓
Parquet
  ↓
QGIS
```

ב־QGIS ניתן להציג:

-   מיקום הפרויקט.
-   AOI.
-   תאריך.
-   NDVI.
-   BSI.
-   שינוי ב־NDVI.
-   שינוי ב־BSI.
-   classified state.

------------------------------------------------------------------------

## 16. שלב מתקדם --- זיהוי כבישים

לאחר שה־pipeline עובד, אפשר לבדוק זיהוי של כבישים קיימים.

אין להסתמך על spectral signature בלבד.

צריך לשלב:

### Spectral

``` text
NDVI
BSI
SWIR
Red/NIR
```

### Spatial

``` text
linearity
elongation
width
continuity
connected components
```

### Context

``` text
existing road network
road centerlines
land cover
construction projects
```

Sentinel-2 ברזולוציית 10m מתאים בעיקר לכבישים רחבים.

כבישים עירוניים צרים עלולים להיות mixed pixels ולכן יהיו בעייתיים יותר.

------------------------------------------------------------------------

## 17. שלב מתקדם --- זיהוי שלבי סלילה

לאחר שיש time series, ניתן לבנות classifier.

אפשר להתחיל פשוט:

``` text
IF vegetation high
    → NATURAL

IF vegetation drops sharply
AND bare-soil signal rises
    → EARTHWORK

IF bare-soil signal remains high
AND spectral signature changes
    → FORMATION / SUBBASE

IF SWIR/visible pattern changes
AND linear structure is established
    → PAVED

IF spectral signal stabilizes
AND road is connected to existing network
    → OPERATIONAL
```

אבל אלה יהיו hypotheses בלבד.

ה־classifier צריך להיבדק מול ground truth.

------------------------------------------------------------------------

## 18. Ground truth

צריך לבחור מספר פרויקטים שבהם ידועים תאריכים של:

-   תחילת עבודות.
-   עבודות עפר.
-   מצע.
-   אספלט.
-   פתיחה לתנועה.

רצוי לבחור:

-   כבישים רחבים.
-   פרויקטים באזורים פתוחים.
-   פרויקטים עם מעט הצללה.
-   כמה סוגי קרקע.

לאחר מכן להשוות:

``` text
observed construction stage
        VS
Sentinel-2 spectral state
```

------------------------------------------------------------------------

## 19. קריטריוני הצלחה של ה־POC

### שלב 1 --- Connectivity

הצלחה אם:

-   STAC search עובד.
-   מתקבלים Sentinel-2 L2A scenes.
-   מתקבלים asset URLs.
-   DuckDB מצליח להשתמש ב־CDSE credentials.

### שלב 2 --- Raster

הצלחה אם:

-   DuckDB קורא asset raster אמיתי.
-   אפשר לקרוא metadata.
-   אפשר לקרוא חלון קטן.
-   אין צורך להוריד את כל ה־scene.

### שלב 3 --- Spectral

הצלחה אם ניתן לחשב:

``` text
NDVI
BSI
band ratios
```

על AOI.

### שלב 4 --- Temporal

הצלחה אם ניתן להפיק:

``` text
date × project × spectral features
```

עבור עשרות/מאות scenes.

### שלב 5 --- Construction detection

הצלחה אם קיימת הפרדה סבירה בין שלבי הביצוע בפרויקטים עם ground truth.

------------------------------------------------------------------------

## 20. סדר הפיתוח המומלץ

לא לבנות הכול בבת אחת.

### Milestone 1

``` text
STAC
  ↓
find Sentinel-2 L2A COG scene
```

### Milestone 2

``` text
COG URL
   ↓
geotiff.js range read
  ↓
AOI pixels
```

### Milestone 3

``` text
B04 + B08
   ↓
NDVI
   ↓
AOI statistics
```

### Milestone 4

``` text
B04 + B08 + B11 + B12
   ↓
NDVI + BSI + ratios
```

### Milestone 5

``` text
multiple dates
   ↓
temporal features
```

### Milestone 6

``` text
projects
   ↓
construction-stage classification
```

------------------------------------------------------------------------

## 21. מה לא לעשות בשלב הראשון

לא להתחיל עם:

-   כל ישראל.
-   כל ה־Sentinel-2 bands.
-   כל התאריכים.
-   machine learning.
-   neural networks.
-   GEE.
-   הורדה מקומית של כל ה־SAFE products.
-   PostGIS.
-   pipeline מורכב ב־Python.

ה־POC צריך לענות קודם על שאלה אחת:

> האם אפשר לקחת Sentinel-2 אמיתי מ־Copernicus Data Space, לקרוא את
> ה־metadata שלו מ־STAC, לקרוא COG קטן ישירות בדפדפן, ולחשב ממנו features
> שימושיים עבור AOI קטן בלי להוריד SAFE מלא?

אם התשובה חיובית, כל שאר המערכת ניתנת לבנייה מעליה.

------------------------------------------------------------------------

## 22. ארכיטקטורה סופית רצויה

``` text
             CDSE STAC / Earth Search STAC
                            │
                            │ metadata + COG URLs
                            ▼
                    ┌─────────────────┐
                    │  DuckDB-WASM    │
                    │                 │
                    │ metadata        │
                    │ Parquet         │
                    └────────┬────────┘
                             │
                             │ AOI / results
                             ▼
                    ┌─────────────────┐
                    │   geotiff.js    │
                    │  COG range read │
                    └────────┬────────┘
                             │
                             ▼
                  ┌──────────┼──────────┐
                  ▼          ▼          ▼
                B04/B08    B11/B12     SCL
                  │          │          │
                  └──────────┼──────────┘
                             ▼
                    Spectral features
                             │
                             ▼
                    Temporal features
                             │
                             ▼
                         Parquet
                             │
                 ┌───────────┴───────────┐
                 ▼                       ▼
               DuckDB                   QGIS
                 │
                 ▼
       Road/construction analysis
```

------------------------------------------------------------------------

## 23. התוצאה הרצויה

בסוף ה־POC צריך להיות אפשרי להריץ workflow שבו המשתמש נותן:

``` text
AOI
date range
cloud threshold
```

ומקבל:

``` text
scene/date
valid_fraction
NDVI
BSI
band statistics
temporal changes
```

כ־Parquet, בלי להחזיק עותק מקומי מלא של Sentinel-2.

רק לאחר שה־workflow הזה מוכח יש טעם להשקיע במודל שמסווג:

``` text
NATURAL
EARTHWORK
FORMATION
PAVED
OPERATIONAL
```

------------------------------------------------------------------------

## 24. מקורות טכניים שיש לבדוק בזמן המימוש

ה־POC צריך להיצמד לתיעוד העדכני של:

-   Copernicus Data Space STAC API
-   Copernicus Data Space S3 API
-   DuckDB `httpfs`
-   DuckDB Secrets
-   DuckDB Spatial
-   DuckDB-WASM
-   Earth Search Sentinel-2 L2A STAC API
-   `geotiff.js`

חשוב במיוחד לא להניח ש־Sentinel-2 של CDSE הוא COG. ה־assets מסוג JP2 של
CDSE נשארים נפרדים ממסלול ה־COG בדפדפן.
