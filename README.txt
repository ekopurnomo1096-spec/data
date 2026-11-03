CARA PASANG (sekali saja)
Di Vercel: Project > Settings > Environment Variables, tambahkan:

  SERPAPI_KEY   = API key dari serpapi.com (untuk sumber "Google Maps")
  GEOAPIFY_KEY  = API key dari geoapify.com (opsional, untuk sumber "OpenStreetMap")

Centang Production, Preview, Development. Lalu Deployments > titik tiga di deploy terbaru > Redeploy.
JANGAN menaruh API key di index.html atau di GitHub.
