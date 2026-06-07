import urllib.request
import json
import ssl
import os

url = "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector"
headers = {
    "Authorization": f"Bearer {os.environ.get('HF_TOKEN', '')}",
}

# Create a dummy payload (e.g., empty bytes) just to see the response code
req = urllib.request.Request(url, data=b"dummy_data", headers=headers, method="POST")

try:
    context = ssl._create_unverified_context()
    with urllib.request.urlopen(req, context=context) as response:
        print("Status:", response.status)
        print(response.read().decode())
except urllib.error.HTTPError as e:
    print("HTTP Error:", e.code, e.reason)
    print(e.read().decode())
except Exception as e:
    print("Error:", str(e))
