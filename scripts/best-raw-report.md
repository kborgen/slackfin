# bestRaw historical sample

Generated 2026-07-27T15:39:55.746Z by `scripts/sample-best-raw.mjs`.
Regenerate with `npm run sample:best-raw`.

60 of 60 sampled days succeeded. Each day is a 42-hour
window from local midnight, scored with `computeRawPoints` from `src/scoring.js`,
which is the same function the app runs. Tides come from NOAA predictions on the
endpoint the app uses. Weather comes from the Open-Meteo ERA5 archive rather than
the live forecast endpoint, because past forecasts are not retained. Archive values
are reanalysis, so a given day will not reproduce exactly what the app showed at
the time. The distribution is what matters here.

## Recommendation

**25th percentile bestRaw = 0.6219, current DECENT_RAW = 0.58**

The floor sits below the 25th percentile, so it engages on fewer than a quarter of days. 2 of 60 sampled days (3%) fell under it.

Not applied automatically. Change `DECENT_RAW` in `src/scoring.js` deliberately.

## Percentiles

| percentile | bestRaw |
| --- | --- |
| 10th | 0.6025 |
| 25th | 0.6219 |
| 40th | 0.6555 |
| 50th (median) | 0.6887 |
| 75th | 0.7683 |

Min 0.5374, max 0.8688, mean 0.6960.

## Distribution

```
0.537 - 0.571    2  #######
0.571 - 0.604    5  #################
0.604 - 0.637   12  ########################################
0.637 - 0.670    8  ###########################
0.670 - 0.703    7  #######################
0.703 - 0.736    6  ####################
0.736 - 0.769    6  ####################
0.769 - 0.803    7  #######################
0.803 - 0.836    4  #############
0.836 - 0.869    3  ##########
```

## Coverage

Confirms the sample is not concentrated in one season or one part of the lunar cycle.

| season | days | median bestRaw |
| --- | --- | --- |
| winter | 15 | 0.6955 |
| spring | 15 | 0.72 |
| summer | 15 | 0.6219 |
| fall | 15 | 0.6762 |

| tide state | days | median bestRaw |
| --- | --- | --- |
| spring | 29 | 0.6955 |
| neap | 31 | 0.6704 |

## All days, ascending by bestRaw

| date | bestRaw | tide range (ft) | tide state | season | station |
| --- | --- | --- | --- | --- | --- |
| 2025-12-10 | 0.5374 | 13.16 | neap | winter | Tacoma |
| 2025-12-22 | 0.5608 | 14.26 | spring | winter | Tacoma |
| 2026-07-02 | 0.5882 | 13.65 | spring | summer | Tacoma |
| 2025-11-22 | 0.5959 | 13.74 | spring | fall | Tacoma |
| 2025-08-12 | 0.5976 | 12.24 | spring | summer | Tacoma |
| 2026-06-02 | 0.5982 | 13.74 | spring | summer | Tacoma |
| 2026-06-20 | 0.603 | 12.17 | neap | summer | Tacoma |
| 2026-01-21 | 0.6127 | 14.04 | spring | winter | Tacoma |
| 2025-07-31 | 0.6133 | 9.13 | neap | summer | Tacoma |
| 2026-07-20 | 0.6159 | 10.06 | neap | summer | Tacoma |
| 2026-01-09 | 0.6173 | 10.16 | neap | winter | Tacoma |
| 2026-02-08 | 0.6174 | 10.08 | neap | winter | Tacoma |
| 2026-05-03 | 0.6182 | 13.21 | spring | spring | Tacoma |
| 2026-04-21 | 0.6206 | 14.46 | neap | spring | Tacoma |
| 2025-08-30 | 0.6218 | 8.6 | neap | summer | Tacoma |
| 2025-08-24 | 0.6219 | 11.94 | spring | summer | Tacoma |
| 2025-11-10 | 0.6287 | 14.6 | neap | fall | Tacoma |
| 2026-03-22 | 0.6312 | 13.78 | neap | spring | Tacoma |
| 2026-03-10 | 0.6357 | 8.95 | neap | spring | Tacoma |
| 2025-09-23 | 0.6396 | 10.41 | spring | fall | Tacoma |
| 2026-05-21 | 0.6401 | 14.19 | neap | spring | Tacoma |
| 2026-04-03 | 0.6422 | 11.97 | spring | spring | Tacoma |
| 2025-09-11 | 0.645 | 13.12 | neap | fall | Tacoma |
| 2025-10-11 | 0.6458 | 14.31 | neap | fall | Tacoma |
| 2026-07-14 | 0.662 | 16.43 | spring | summer | Tacoma |
| 2025-10-23 | 0.6676 | 12.53 | spring | fall | Tacoma |
| 2026-01-27 | 0.6694 | 12.59 | neap | winter | Tacoma |
| 2025-11-28 | 0.6704 | 10.63 | neap | fall | Tacoma |
| 2025-09-29 | 0.6762 | 9.55 | neap | fall | Tacoma |
| 2026-02-20 | 0.6875 | 11.55 | spring | winter | Tacoma |
| 2026-06-14 | 0.69 | 16.71 | spring | summer | Tacoma |
| 2025-10-29 | 0.6906 | 10.48 | neap | fall | Tacoma |
| 2026-02-02 | 0.6955 | 14.74 | spring | winter | Tacoma |
| 2026-06-08 | 0.6973 | 9.14 | neap | summer | Tacoma |
| 2026-05-15 | 0.7182 | 15.3 | spring | spring | Tacoma |
| 2026-07-08 | 0.7188 | 11.75 | neap | summer | Tacoma |
| 2026-04-09 | 0.72 | 9.43 | neap | spring | Tacoma |
| 2026-02-26 | 0.7322 | 12.15 | neap | winter | Tacoma |
| 2026-04-15 | 0.7325 | 11.51 | spring | spring | Tacoma |
| 2026-05-09 | 0.7325 | 9.92 | neap | spring | Tacoma |
| 2025-12-28 | 0.7395 | 12.04 | neap | winter | Tacoma |
| 2025-09-17 | 0.7636 | 11.84 | neap | fall | Tacoma |
| 2025-08-06 | 0.7643 | 12.92 | spring | summer | Tacoma |
| 2025-08-18 | 0.7682 | 12.7 | neap | summer | Tacoma |
| 2026-01-03 | 0.7682 | 16.89 | spring | winter | Tacoma |
| 2026-05-27 | 0.7686 | 12.24 | neap | spring | Tacoma |
| 2025-09-05 | 0.7704 | 12.46 | spring | fall | Tacoma |
| 2026-03-28 | 0.7751 | 11.4 | neap | spring | Tacoma |
| 2026-04-27 | 0.7762 | 10.16 | neap | spring | Tacoma |
| 2025-10-05 | 0.7779 | 11.12 | spring | fall | Tacoma |
| 2026-06-26 | 0.7782 | 12.82 | spring | summer | Tacoma |
| 2025-10-17 | 0.7846 | 9.94 | neap | fall | Tacoma |
| 2026-03-04 | 0.7865 | 11.34 | spring | spring | Tacoma |
| 2025-12-04 | 0.8067 | 17.04 | spring | winter | Tacoma |
| 2025-11-16 | 0.8093 | 10.9 | neap | fall | Tacoma |
| 2026-02-14 | 0.8167 | 12.22 | spring | winter | Tacoma |
| 2026-01-15 | 0.8226 | 12.64 | spring | winter | Tacoma |
| 2026-03-16 | 0.846 | 11.22 | spring | spring | Tacoma |
| 2025-11-04 | 0.8585 | 14.6 | spring | fall | Tacoma |
| 2025-12-16 | 0.8688 | 11.96 | spring | winter | Tacoma |

## Skipped days

None. Every sampled day returned complete tide and weather data.
