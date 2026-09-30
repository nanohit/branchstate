[out:json][timeout:500][maxsize:2000000000];
(
  relation["boundary"="administrative"]["admin_level"="2"](34,-11,63,43)
    (if: t["start_date"] < "1914-08" && (!is_tag("end_date") || t["end_date"] > "1914-07"));
  relation(id:2856862,2661870,2684067,2800213,2746401,2800214,2696322,2692704,2857683,2692703);
);
out geom;
