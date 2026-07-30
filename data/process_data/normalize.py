'''
规范化课程、教师名称
'''

import re

def parens(s: str) -> str:
    """将全角括号统一转换为半角括号"""
    return s.replace('（', '(').replace('）', ')')

def strip_all_whitespace(s: str) -> str:
    """去除字符串中所有空白字符（空格、制表符、换行等）"""
    return re.sub(r'\s+', '', s)

def jsm(s: str) -> str:
    '''规范教师名'''
    return parens(s.strip())

def kcm(s: str) -> str:
    '''规范课程名'''
    return parens(strip_all_whitespace(s))

def full_name(s: str) -> str:
    '''规范全名'''
    sp = parens(s)

    # 找到最后一个右括号，作为jsm的闭合括号
    last_rp = sp.rfind(')')
    if last_rp == -1:
        # 没有右括号，整体当作课程名处理
        return kcm(sp)

    # 从 last_rp 向前扫描，找到与之匹配的左括号
    depth = 0
    match_lp = -1
    for i in range(last_rp, -1, -1):
        ch = sp[i]
        if ch == ')':
            depth += 1
        elif ch == '(':
            depth -= 1
            if depth == 0:
                match_lp = i
                break

    if match_lp == -1:
        # 未找到匹配的左括号，整体当作课程名处理
        return kcm(sp)

    # 分离课程名和教师名
    kcm_raw = sp[:match_lp]
    jsm_raw = sp[match_lp + 1:last_rp]

    # 分别规范化
    kcm_norm = kcm(kcm_raw)
    jsm_norm = jsm(jsm_raw)

    return f'{kcm_norm}({jsm_norm})'