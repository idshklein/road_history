כן. מצאתי ספרות רלוונטית, והיא משנה מעט את ההנחה הראשונית שלנו. **אין "חתימה ספקטרלית של כביש" אחת**, ובמיוחד יש בעיה בהפרדה בין **אספלט לבין קרקע חשופה**. אבל יש די עקביות לגבי אילו ערוצים שימושיים ואילו כמעט לא שווים את העלות ברזולוציית Sentinel-2.

### מה הספרות אומרת

מחקר שבחן ישירות את יכולת Sentinel-2 להפריד בין **Road / Bare soil** מצא שזה אחד הזוגות הקשים ביותר להפרדה ספקטרלית. לעומת זאת, Sentinel-2 נותן יתרון דווקא ב־Blue וב־SWIR ובאינדקסים הנגזרים מהם. ([MDPI][1])

מחקר אחר על חילוץ impervious surfaces מצא ש־SWIR, במיוחד B11/B12, נותן מידע משמעותי להפרדה בין משטחים אטומים לבין קרקע חשופה. ([ScienceDirect][2])

ויש מחקר חדש יותר, ספציפי מאוד לכבישים, שבו נבדקו 7 ערוצים:

**B2, B3, B4, B8, B8A, B11, B12**

והחוקרים מצאו שכל אחד מהם תורם במידה מסוימת להבחנה בין מצבי אספלט. בפרט:

* **B3/B4** — רגישות למאפייני פני השטח.
* **B11/B12** — מידע הקשור בין היתר ללחות.
* **B2/B8A** — תרומה אפשרית למאפייני חומר האספלט.
* שילוב של כל התחומים נותן מידע נוסף. ([ResearchGate][3])

זה חשוב מאוד למקרה שלנו: **לא הייתי זורק את B11/B12**, גם אם הם 20m.

---

## אז אילו ערוצים הייתי משאיר?

ל־POC שלנו הייתי מתחיל עם:

| Band    | λ מרכזי | החלטה   | למה                                     |
| ------- | ------: | ------- | --------------------------------------- |
| **B2**  |  490 nm | ✓       | Blue; נמצא כמועיל להפרדת Road/Bare soil |
| **B3**  |  560 nm | ✓       | מידע על פני השטח                        |
| **B4**  |  665 nm | ✓       | מידע על אלבדו/מצב האספלט + NDVI         |
| **B5**  |  705 nm | ?       | Red-edge; כנראה פחות קריטי לכביש עצמו   |
| **B6**  |  740 nm | ?       | כנ"ל                                    |
| **B7**  |  783 nm | ?       | כנ"ל                                    |
| **B8**  |  842 nm | ✓       | NIR; חשוב במיוחד להפרדה מצמחייה         |
| **B8A** |  865 nm | ✓/ניסוי | נמצא רלוונטי במחקרי אספלט               |
| **B11** | 1610 nm | **✓✓**  | SWIR; קריטי להבדלה מחומרים/לחות         |
| **B12** | 2190 nm | **✓✓**  | SWIR; מידע נוסף על חומר ולחות           |
| B1      |  443 nm | ✗       | 60m; aerosol                            |
| B9      |  945 nm | ✗       | 60m; water vapour                       |
| B10     | 1375 nm | ✗       | 60m; cirrus                             |

ההבחנה האחרונה די ברורה: **B1/B9/B10 לא הייתי מכניס בכלל למודל הספקטרלי**. הם 60m ונועדו בעיקר למטרות אטמוספריות/עננות, לא לאפיון פני הקרקע. גם עבודות Sentinel-2 עדכניות שעושות band selection מוציאות את שלושת הערוצים האלה ומשאירות את עשרת ערוצי ה־10/20m. ([Nature][4])

---

# אבל יש כאן תובנה חשובה יותר

אני חושב שה־POC שלנו צריך להשתנות מעט.

במקום:

> "איזה band מזהה כביש?"

השאלה צריכה להיות:

> **"איזה שילוב של bands מבדיל בין asphalt / bare soil / vegetation, ובאיזה שלב של בניית הכביש משתנה ה־spectral state?"**

כי הספרות מצביעה על משהו די עקבי:

```text
                    Vegetation
                       ↑
                       │
                       │ קל יחסית
                       │
Bare soil ←────────────┼────────────→ Asphalt
                       │
                       │
                 קשה להפריד
```

ה־NIR, ובעיקר היחס בין NIR ל־Red, נותן לנו הפרדה טובה מצמחייה.

אבל:

```text
ASPHALT ↔ BARE SOIL
```

הוא הרבה יותר בעייתי. ([MDPI][1])

ולכן **BSI לבדו לא יהיה פתרון**.

---

# ומה לגבי שלבי סלילה?

כאן מצאתי משהו רלוונטי במיוחד למחקר שלנו.

מחקר מ־2024 על **זיהוי בנייה חדשה באמצעות time series של Landsat ו־Sentinel-2** לא חיפש "חתימת כביש" בתמונה בודדת. הוא זיהה שינויי מצב של משטח:

```text
vegetated
    ↓
bare soil / ground preparation
    ↓
new surface
```

והשתמש בשינויים לאורך זמן כדי לזהות בנייה. ([DOI][5])

זה הרבה יותר קרוב למה שאנחנו רוצים לעשות.

כלומר, במקום לחפש:

```text
P(asphalt | B2,B3,B4,B8,B11,B12)
```

אפשר לחפש:

```text
P(stage | ΔB2, ΔB3, ΔB4, ΔB8, ΔB11, ΔB12,
         ΔNDVI, ΔBSI, temporal context)
```

וזה לדעתי כיוון הרבה יותר חזק.

---

## הייתי בונה את ה־feature set הראשוני כך

### Raw spectral

```text
B2
B3
B4
B8
B8A
B11
B12
```

### Indices

```text
NDVI
BSI
NDBI
```

### Ratios

```text
B2/B4
B4/B8
B8/B11
B11/B12
```

### Temporal

```text
ΔB2
ΔB3
ΔB4
ΔB8
ΔB11
ΔB12

ΔNDVI
ΔBSI
ΔNDBI
```

ואז לתת ל־Random Forest / XGBoost / אפילו PCA + clustering לקבוע **אילו features באמת מפרידים בין השלבים**.

---

### ומה לא הייתי עושה

לא הייתי מתחיל עם:

```text
B1
B9
B10
```

ולא הייתי מתחיל גם עם כל ה־red-edge:

```text
B5
B6
B7
```

לא משום שהם "לא מכילים מידע", אלא משום שהמידע שלהם מכוון בעיקר לצמחייה. למשל, Sentinel-2 מגדיר את B5–B7 במפורש כ־vegetation/red-edge bands. ([GDAL][6])

לכן הייתי עושה **ablation test**:

```text
Model A: B2 B3 B4 B8 B11 B12

Model B: A + B8A

Model C: B + B5 B6 B7
```

ומודד כמה באמת משתפרת ההפרדה.

זה יענה בצורה אמפירית על השאלה האם ה־red-edge שווה את המורכבות והרזולוציה הנמוכה יותר, במקום להניח מראש.

**הסט הראשוני שהייתי מעביר ל־DuckDB הוא לכן B2, B3, B4, B8, B8A, B11, B12 + SCL.** B1/B9/B10 הייתי משאיר מחוץ לניתוח. ([ResearchGate][7])

[1]: https://www.mdpi.com/2072-4292/8/6/488?utm_source=chatgpt.com "Sentinel-2’s Potential for Sub-Pixel Landscape Feature Detection"
[2]: https://www.sciencedirect.com/science/article/pii/S2667010022001251?utm_source=chatgpt.com "Evaluation of spectral built-up indices for impervious surface extraction using Sentinel-2A MSI imageries: A case of Addis Ababa city, Ethiopia - ScienceDirect"
[3]: https://www.researchgate.net/publication/394230753_Exploring_relationships_between_Copernicus_Sentinel-2_multispectral_data_and_international_roughness_index_of_roads_in_Kenya?utm_source=chatgpt.com "(PDF) Exploring relationships between Copernicus Sentinel-2 multispectral data and international roughness index of roads in Kenya"
[4]: https://www.nature.com/articles/s41598-026-55916-9?utm_source=chatgpt.com "Integrating multi-source remote sensing, field work, and petrography for automatic lithological mapping and mineralization potential in the Gabal El-Faraid, Egypt | Scientific Reports"
[5]: https://doi.org/10.1016/j.srs.2024.100138?utm_source=chatgpt.com "Broad-area-search of new construction using time series analysis of Landsat and Sentinel-2 data - ScienceDirect"
[6]: https://gdal.org/en/stable/drivers/raster/sentinel2.html?utm_source=chatgpt.com "SENTINEL2 -- Sentinel-2 Products — GDAL documentation"
[7]: https://www.researchgate.net/publication/395892820_Classification_of_road_pavement_condition_using_fuzzy_clustering_and_Sentinel-2_multispectral_data "(PDF) Classification of road pavement condition using fuzzy clustering and Sentinel-2 multispectral data"
