'''
从网络学堂获取最新课程数据
'''


import requests
import time
import json
import os

import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# 每次只需替换cookies即可
headers = {
  "Host": "learn.tsinghua.edu.cn",
  "Connection": "keep-alive",
  "Content-Length": "1251",
  "sec-ch-ua-platform": "\"Windows\"",
  "sec-ch-ua": "\"Chromium\";v=\"148\", \"Microsoft Edge\";v=\"148\", \"Not/A)Brand\";v=\"99\"",
  "sec-ch-ua-mobile": "?0",
  "X-Requested-With": "XMLHttpRequest",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0",
  "Accept": "application/json, text/javascript, */*; q=0.01",
  "DNT": "1",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "Origin": "https://learn.tsinghua.edu.cn",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
  "Referer": "https://learn.tsinghua.edu.cn/f/wlxt/common/courseSearch",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,en-GB;q=0.6",
  "Cookie": "cna=db11813f37714c0080932cf54d91162c; _ga=GA1.1.1100183838.1760759360; _ga_P4N729JCZG=GS2.1.s1760759359$o1$g0$t1760759363$j56$l0$h0; XSRF-TOKEN=c699c357-ebfb-4b4e-b954-cb3d92365c72; JSESSIONID=6EE4180D61181A82F2F2737F1A88A14D.wlxt20181; !Proxy!PHPSESSID=4dembp48aqkm26jiijc88lcml5"
}

# 每次需更新（csrf会变）
url = "https://learn.tsinghua.edu.cn/b/kc/v_wlkc_search/pageList?_csrf=c699c357-ebfb-4b4e-b954-cb3d92365c72&_csrf=c699c357-ebfb-4b4e-b954-cb3d92365c72"

# 请求体，将{'name': 'iDisplayLength', 'value': 215988}中的value改为显示的课程总数，可一次获取全部信息
# aoData = [{'name': 'sEcho', 'value': 1}, {'name': 'iColumns', 'value': 7}, {'name': 'sColumns', 'value': ',,,,,,'}, {'name': 'iDisplayStart', 'value': 0}, {'name': 'iDisplayLength', 'value': 209548}, {'name': 'mDataProp_0', 'value': 'kcm'}, {'name': 'bSortable_0', 'value': True}, {'name': 'mDataProp_1', 'value': 'jsmc'}, {'name': 'bSortable_1', 'value': True}, {'name': 'mDataProp_2', 'value': 'xnxq'}, {'name': 'bSortable_2', 'value': True}, {'name': 'mDataProp_3', 'value': 'kfyhlx'}, {'name': 'bSortable_3', 'value': True}, {'name': 'mDataProp_4', 'value': 'kkdw'}, {'name': 'bSortable_4', 'value': True}, {'name': 'mDataProp_5', 'value': 'xss'}, {'name': 'bSortable_5', 'value': True}, {'name': 'mDataProp_6', 'value': 'lls'}, {'name': 'bSortable_6', 'value': True}, {'name': 'iSortingCols', 'value': 0}]
aoData = [{'name': 'sEcho', 'value': 1}, {'name': 'iColumns', 'value': 7}, {'name': 'sColumns', 'value': ',,,,,,'}, {'name': 'iDisplayStart', 'value': 0}, {'name': 'iDisplayLength', 'value': 215988}, {'name': 'mDataProp_0', 'value': 'kcm'}, {'name': 'bSortable_0', 'value': True}, {'name': 'mDataProp_1', 'value': 'jsmc'}, {'name': 'bSortable_1', 'value': True}, {'name': 'mDataProp_2', 'value': 'xnxq'}, {'name': 'bSortable_2', 'value': True}, {'name': 'mDataProp_3', 'value': 'kfyhlx'}, {'name': 'bSortable_3', 'value': True}, {'name': 'mDataProp_4', 'value': 'kkdw'}, {'name': 'bSortable_4', 'value': True}, {'name': 'mDataProp_5', 'value': 'xss'}, {'name': 'bSortable_5', 'value': True}, {'name': 'mDataProp_6', 'value': 'lls'}, {'name': 'bSortable_6', 'value': True}, {'name': 'iSortingCols', 'value': 0}]

def fetch_course_data(page):
    # 获取指定页码的课程数据，page从1开始。原本计划遍历页码获取，但发现通过修改请求体中每页显示的数量可以一页获取全部课程数据，因此正确修改请求体后只需调用一次传入1即可。
    cache_data = aoData.copy()
    cache_data[3]['value'] = (page - 1) * 100 
    data = {"aoData": json.dumps(cache_data, separators=(",", ":"))}
    try:
        response = requests.post(url, headers=headers, data=data, verify=False)
        response.raise_for_status()
        return response.json()
    except requests.RequestException as e:
        print(f"Error fetching course data for page {page}: {e}")
        return None
    
if __name__ == "__main__":
    payload = fetch_course_data(1)
    with open("./data/learn/courses_2026-2027-1.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=4)
    # print(json.dumps(payload, ensure_ascii=False, indent=4))